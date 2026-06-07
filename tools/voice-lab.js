// Voice lab — offline A/B bench for the BDC manager voice.
//
// Renders canonical BDC call moments through the SAME Fish path the live call
// uses (fish.js), so what you hear here is what the phone will do. Each line is
// synthesized twice — once WITH the emotion tags Claude would emit, once with
// them stripped — so you can hear exactly what the tags buy you.
//
// It inherits every FISH_* knob from .env (temperature, speed, latency, model,
// reference_id...), so you can A/B-tune by editing .env and re-running — no code
// edits. Output is 16-bit mono WAV at LAB_SAMPLE_RATE (default 44.1 kHz, clean
// for listening — NOT the 8 kHz telephony rate).
//
// Usage:
//   node tools/voice-lab.js                 # render the built-in script
//   node tools/voice-lab.js "[warm] Hi, is this Dave?"   # render one custom line
//   LAB_PLAIN=0 node tools/voice-lab.js     # tagged variants only
//
// Requires FISH_API_KEY and FISH_MODEL_ID in .env.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { FishTTS } = require('../fish');

const RATE = Number(process.env.LAB_SAMPLE_RATE || 44100);
const WITH_PLAIN = process.env.LAB_PLAIN !== '0';
const OUT_DIR = path.join(__dirname, 'voice-lab-out');

// Canonical BDC moments, tagged the way brain.js teaches Claude to tag (s2-pro
// [bracket] syntax). Keep these representative of real turns on a call.
const SCRIPT = [
  { id: 'greeting', text: `[warm] Hey, is this Dave? [upbeat] This is Sam over at the dealership — how's your morning going?` },
  { id: 'value-build', text: `[confident] So the one you were looking at is still on the lot, and it's honestly nicer in person. Come see it and I'll have it pulled up front for you.` },
  { id: 'price-deflect', text: `[easygoing] I hear you on the payment. [matter-of-fact] That's exactly the kind of thing my manager sharpens his pencil on when you're sitting here — and we usually get you more for your trade than you'd expect.` },
  { id: 'objection', text: `[empathetic] Totally fair, I get it. [reassuring] No pressure at all — even a quick fifteen-minute look, and if it's not right, you walk. Fair enough?` },
  { id: 'the-ask', text: `[warm] So does tomorrow at five work for you, or is Saturday morning easier?` },
  { id: 'curious-after-no', text: `[genuinely curious] Can I ask — is it the timing that's tough, or was it something about a past experience that's making you hesitate?` },
  { id: 'yes-celebrate', text: `[excited] Perfect, I've got you down for Saturday at ten! [warm] Ask for Sam when you walk in, I'll be looking out for you.` },
];

const stripTags = (s) =>
  s.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

function wavHeader(dataLen, rate, channels = 1, bits = 16) {
  const blockAlign = (channels * bits) / 8;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

// One full synth over a fresh Fish connection; resolves with PCM16 LE bytes.
function synth(text) {
  return new Promise((resolve, reject) => {
    const fish = new FishTTS({ sampleRate: RATE });
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fish.close(); } catch {}
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, 30000); // safety net
    fish.on('audio', (b) => chunks.push(b));
    fish.on('finish', finish);
    fish.on('close', finish);
    fish.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    fish.on('ready', () => {
      fish.pushText(text);
      fish.flush();
      fish.end(); // no more text -> Fish renders, streams audio, emits 'finish'
    });
    fish.connect();
  });
}

async function render(label, text, file) {
  process.stdout.write(`  ${label.padEnd(26)} `);
  const t0 = Date.now();
  const pcm = await synth(text);
  const secs = pcm.length / (RATE * 2);
  fs.writeFileSync(file, Buffer.concat([wavHeader(pcm.length, RATE), pcm]));
  console.log(`${secs.toFixed(1)}s audio  (${((Date.now() - t0) / 1000).toFixed(1)}s render)  -> ${path.basename(file)}`);
}

async function main() {
  if (!process.env.FISH_API_KEY || !process.env.FISH_MODEL_ID) {
    console.error('Missing FISH_API_KEY or FISH_MODEL_ID in .env');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const model = process.env.FISH_TTS_MODEL || 's2-pro';
  console.log(`\nVoice lab — model=${model}  voice=${process.env.FISH_MODEL_ID}`);
  console.log(`temp=${process.env.FISH_TEMPERATURE || '0.6'}  top_p=${process.env.FISH_TOP_P || '0.7'}  speed=${process.env.FISH_SPEED || '1.0'}  rate=${RATE}Hz\n`);

  // Custom one-off line from argv.
  const custom = process.argv[2];
  const items = custom
    ? [{ id: 'custom', text: custom }]
    : SCRIPT;

  let n = 0;
  for (const item of items) {
    const i = String(++n).padStart(2, '0');
    await render(`${i} ${item.id} [tagged]`, item.text, path.join(OUT_DIR, `${i}-${item.id}.tagged.wav`));
    if (WITH_PLAIN) {
      const plain = stripTags(item.text);
      await render(`${i} ${item.id} [plain]`, plain, path.join(OUT_DIR, `${i}-${item.id}.plain.wav`));
    }
  }

  console.log(`\nDone. ${WITH_PLAIN ? 'Compare .tagged vs .plain ' : ''}WAVs in ${OUT_DIR}`);
  console.log(`Listen:  open ${OUT_DIR}\n`);
}

main().catch((e) => {
  console.error('voice-lab error:', e.message);
  process.exit(1);
});
