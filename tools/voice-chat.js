// Terminal voice chat with the agent — talk via your mic, hear it reply, all in
// the terminal. Reuses the same brain (Claude) + voice (Fish) + STT (Deepgram)
// as the sim. No Twilio, no browser.
//
// Requires ffmpeg + ffplay on PATH (macOS has no built-in CLI mic capture):
//   - install Homebrew:  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
//   - then:              brew install ffmpeg
//
// Usage:
//   npm run voice-chat            # start talking
//   node tools/voice-chat.js --list   # list mic device indices
//   MIC_DEVICE=1 npm run voice-chat    # pick a specific mic (default 0)

require('dotenv').config();
const { spawn, execSync } = require('child_process');
const { Brain } = require('../brain');
const { FishTTS } = require('../fish');
const { DeepgramSTT } = require('../stt');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPLAY = process.env.FFPLAY_BIN || 'ffplay';
const MIC = process.env.MIC_DEVICE || '0';
const OUT_RATE = 24000; // Fish PCM rate for clean local playback

function have(bin) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

function preflight() {
  const missing = [];
  if (!have(FFMPEG)) missing.push('ffmpeg');
  if (!have(FFPLAY)) missing.push('ffplay');
  if (missing.length) {
    console.error(`\n❌ Missing: ${missing.join(', ')} (needed for terminal mic + playback).`);
    console.error('Install Homebrew, then ffmpeg:');
    console.error('  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
    console.error('  brew install ffmpeg\n');
    process.exit(1);
  }
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY', 'FISH_API_KEY']) {
    if (!process.env[k]) console.error(`⚠️  ${k} not set in .env — that piece will fail.`);
  }
}

function listDevices() {
  const p = spawn(FFMPEG, ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  p.stderr.pipe(process.stderr);
  p.on('close', () => process.exit(0));
}

async function main() {
  if (process.argv.includes('--list')) return listDevices();
  preflight();

  // Playback: one long-lived ffplay reading raw PCM from stdin.
  const player = spawn(FFPLAY, ['-nodisp', '-autoexit', '-f', 's16le', '-ar', String(OUT_RATE), '-ac', '1', '-i', '-', '-loglevel', 'quiet']);
  player.on('error', (e) => console.error('ffplay error:', e.message));

  // Half-duplex: while the agent is speaking, don't feed the mic to STT (avoids echo).
  let playUntil = 0;
  const agentSpeaking = () => Date.now() < playUntil - 50;

  const brain = new Brain({
    leadContext: process.env.SIM_LEAD || 'Internet lead interested in a vehicle; has not been into the store yet.',
  });

  let fish = null;
  const ensureFish = () => {
    if (fish) return;
    fish = new FishTTS({ sampleRate: OUT_RATE });
    fish.on('audio', (buf) => {
      try { player.stdin.write(buf); } catch {}
      const durMs = (buf.length / (OUT_RATE * 2)) * 1000;
      playUntil = Math.max(playUntil, Date.now()) + durMs;
    });
    fish.on('error', (e) => console.error('fish error:', e.message));
    fish.connect();
  };

  let turning = false;
  const turn = async (genFn) => {
    turning = true;
    let pending = '';
    const speak = (s) => { s = s.trim(); if (!s) return; ensureFish(); fish.pushText(s); fish.flush(); };
    const flush = (force) => {
      let m;
      while ((m = pending.match(/^([\s\S]*?[.!?,;:])\s+/))) { speak(m[1]); pending = pending.slice(m[0].length); }
      if (force && pending.trim()) { speak(pending); pending = ''; }
    };
    const full = await genFn((tok) => {
      pending += tok;
      if (/\[\[\s*HANDOFF/i.test(pending)) return; // don't speak the handoff token
      flush(false);
    });
    if (/\[\[\s*HANDOFF/i.test(full || '')) {
      console.log('🤝  [agent would hand off to a manager]');
      turning = false;
      return;
    }
    flush(true);
    console.log('🤖  Sam:', full);
    turning = false;
  };

  // STT: mic (linear16 16k) -> Deepgram -> turn.
  const stt = new DeepgramSTT({ encoding: 'linear16', sampleRate: 16000 });
  stt.start();
  let buffer = '';
  const fire = async () => {
    const said = buffer.trim();
    buffer = '';
    if (!said || turning) return;
    console.log('🗣   You:', said);
    await turn((onTok) => brain.respond(said, onTok));
  };
  stt.on('transcript', (text, isFinal, speechFinal) => { if (isFinal && text) buffer += (buffer ? ' ' : '') + text; if (speechFinal) fire(); });
  stt.on('utteranceEnd', () => fire());
  stt.on('error', (e) => console.error('stt error:', e.message));

  // Mic capture via ffmpeg (avfoundation). Gated half-duplex.
  const rec = spawn(FFMPEG, ['-f', 'avfoundation', '-i', `:${MIC}`, '-ar', '16000', '-ac', '1', '-f', 's16le', '-loglevel', 'quiet', '-']);
  rec.on('error', (e) => console.error('mic/ffmpeg error:', e.message));
  rec.stdout.on('data', (chunk) => { if (!agentSpeaking()) stt.send(chunk); });

  console.log('\n🎙  Terminal voice chat — just start talking. Ctrl-C to quit.\n');
  await turn((onTok) => brain.greet(onTok)); // agent opens

  const cleanup = () => { try { rec.kill(); } catch {} try { player.kill(); } catch {} try { stt.close(); } catch {} try { if (fish) fish.close(); } catch {} process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((e) => { console.error(e); process.exit(1); });
