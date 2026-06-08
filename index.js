// Realtime AI voice-agent server for the VinSolutions dialer.
//
// Flow (one call at a time):
//   1. Extension POSTs /start-call {customerNumber, script, screenText}.
//   2. We place an outbound Twilio call to the customer with AMD, and a second
//      call to your cell (the monitor leg). Both legs <Connect><Stream> to /media.
//   3. Twilio AMD tells us human vs machine:
//        human   -> Deepgram -> Claude -> Fish, live conversation
//        machine -> Fish plays the voicemail script, then hang up
//   4. You listen on your cell the whole time; POST /take-over to barge in.
//
// Host on Render (persistent WebSocket + TLS). Listens on process.env.PORT.

require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');

const { Session } = require('./session');
const { nextNumber } = require('./numbers');
const { Brain } = require('./brain');
const { CustomerBrain } = require('./customer');
const { FishTTS } = require('./fish');
const { ElevenTTS } = require('./eleven');
// Voice engine for the agent: 'fish' (default) or 'eleven'. STT/LLM unchanged.
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'fish').toLowerCase();
const { DeepgramSTT } = require('./stt');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient: createDeepgram } = require('@deepgram/sdk');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function simTags(text) {
  const out = [];
  for (const re of [/\[[^\]\n]{1,40}\]/g, /\([^)\n]{1,40}\)/g]) {
    const m = (text || '').match(re);
    if (m) out.push(...m);
  }
  return out;
}

// Practice scenarios for the simulator. Each gives the agent the call's situation
// and the specific objective so it opens and behaves appropriately.
const SCENARIOS = {
  internet_lead: {
    label: 'Outbound — Internet Lead',
    leadContext:
      'OUTBOUND CALL — Fresh internet lead. The customer submitted an online inquiry on a 2021 Honda Accord EX-L. They have not been into the store and have not spoken with anyone yet. OBJECTIVE: introduce yourself briefly, confirm their interest, and set a specific appointment time for them to come see the vehicle.',
    customerContext:
      'You are Jordan. A few days ago you filled out an online form on a 2021 Honda Accord EX-L because the price looked decent. You forgot you even did it. You are at work and a little busy. You ARE shopping for a reliable car but you want a ballpark price/monthly payment before you drive anywhere, and you have a current car you might trade in that you think is worth a fair bit. You can come in this week if it sounds worth it, but you are not committing on the first ask.',
  },
  missed_appointment: {
    label: 'Outbound — Missed Appointment',
    leadContext:
      'OUTBOUND CALL — Missed-appointment follow-up. The customer had a scheduled appointment to look at a 2021 Honda Accord and did NOT show up. OBJECTIVE: no guilt trip — warmly find out what came up and reschedule a specific new appointment time.',
    customerContext:
      'You are Jordan. You had an appointment yesterday to see a 2021 Honda Accord but something came up at work and you blew it off without calling. You feel a little bad about it but you are still somewhat interested. You are wary of being pressured. If the rep is cool about you missing it and makes rescheduling easy, you will consider a new time — but you are noncommittal at first and a bit busy.',
  },
  showroom_visit: {
    label: 'Outbound — Showroom Visit Follow-up',
    leadContext:
      'OUTBOUND CALL — Showroom visit follow-up (be-back). The customer came into the store and looked at a 2021 Honda Accord but left without buying. OBJECTIVE: thank them for coming in, surface and address any hesitation, and get them back in to move forward.',
    customerContext:
      'You are Jordan. You went into the store last week and test drove a 2021 Honda Accord. You liked the car but left because the monthly payment came back higher than you wanted and you felt a little rushed. You have been thinking it over and also peeking at other dealers. You need to feel like the numbers can actually work and that you will not get pressured before you would come back in.',
  },
  confirm_appointment: {
    label: 'Outbound — Confirm Appointment',
    leadContext:
      'OUTBOUND CALL — Appointment confirmation. The customer has an UPCOMING appointment (tomorrow) to see a 2021 Honda Accord. OBJECTIVE: confirm they are still planning to come in, lock in the exact time, build a little excitement. Keep it short.',
    customerContext:
      'You are Jordan. You have an appointment tomorrow to see a 2021 Honda Accord. You are mostly still planning to come, but your schedule is tight and you are half-tempted to push it. If the rep confirms a clear time and it is convenient, you will lock it in. Keep it fairly short.',
  },
};

// ---- Style references: drop rep call clips at /sim; we transcribe them and
// distill a style guide the agent emulates (cadence/phrasing/energy). ----
const styleRefs = []; // { name, transcript }
let styleGuidance = '';
const dgClient = process.env.DEEPGRAM_API_KEY ? createDeepgram(process.env.DEEPGRAM_API_KEY) : null;
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function distillStyle() {
  if (!anthropic || !styleRefs.length) { styleGuidance = ''; return; }
  const corpus = styleRefs.map((r, i) => `--- Clip ${i + 1} (${r.name}) ---\n${r.transcript}`).join('\n\n');
  const resp = await anthropic.messages.create({
    model: process.env.LLM_MODEL || 'claude-haiku-4-5',
    max_tokens: 700,
    system:
      'You are a phone-sales coach. Given transcripts of real reps on live calls, write a SHORT, concrete style guide (tight bullet points) capturing HOW they talk: cadence, sentence length, openers, transitions, word choice, energy, humor, and how they ask for the appointment. Capture the style, not the specific deals. Make it directly usable as instructions for another rep to match their delivery.',
    messages: [{ role: 'user', content: `Transcripts:\n\n${corpus}\n\nWrite the style guide.` }],
  });
  styleGuidance = (resp.content.find((b) => b.type === 'text') || {}).text || '';
}

const {
  PORT = 3000,
  PUBLIC_HOST, // e.g. ai-vm-server.onrender.com (no scheme)
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  REP_CELL, // your cell, joined muted to monitor
  SHARED_SECRET = '',
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Optional Neon logging — only if DATABASE_URL is set.
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool
    .query(
      `CREATE TABLE IF NOT EXISTS calls (
         id bigserial PRIMARY KEY, session_id text, customer_call_sid text,
         outcome text, script text, at timestamptz NOT NULL DEFAULT now())`
    )
    .catch((e) => console.error('neon init', e.message));
}

// Crash visibility: log instead of dying silently (Render would 502 on a crash).
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message, e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message, e));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.send('AI voice-agent server up'));

// ---- Call simulator UI (no Twilio, no phone) ----
app.get('/sim', (_req, res) => res.sendFile(path.join(__dirname, 'sim.html')));

// Upload rep call clips (wav/mp3) -> transcribe -> distill a style guide.
app.post('/sim-upload', upload.array('clip', 10), async (req, res) => {
  if (!dgClient) return res.status(400).json({ ok: false, error: 'Deepgram not configured' });
  try {
    const added = [];
    for (const f of req.files || []) {
      const { result, error } = await dgClient.listen.prerecorded.transcribeFile(f.buffer, {
        model: 'nova-2',
        smart_format: true,
      });
      if (error) throw new Error(error.message || 'transcription failed');
      const transcript =
        (result && result.results && result.results.channels[0].alternatives[0].transcript) || '';
      styleRefs.push({ name: f.originalname, transcript });
      added.push({ name: f.originalname, transcript });
    }
    await distillStyle();
    res.json({ ok: true, added, count: styleRefs.length, guidance: styleGuidance });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/sim-style', (_req, res) =>
  res.json({
    count: styleRefs.length,
    refs: styleRefs.map((r) => ({ name: r.name, chars: r.transcript.length })),
    guidance: styleGuidance,
  })
);

app.post('/sim-style/clear', (_req, res) => {
  styleRefs.length = 0;
  styleGuidance = '';
  res.json({ ok: true });
});

// ---- Call breakdown / logs ----
// GET /calls            -> list recent calls (+ the live one)
// GET /calls/:id        -> full timestamped breakdown w/ emotion tags (JSON)
// GET /calls/:id?text=1 -> human-readable transcript
app.get('/calls', (_req, res) => {
  const list = [];
  if (active && active.mode !== 'done') {
    list.push({ id: active.id, to: active.customerNumber, status: active.mode, turns: active.transcript.length, live: true });
  }
  list.push(...callLogs.map(callSummary));
  res.json(list);
});

app.get('/calls/:id', (req, res) => {
  let c = callLogs.find((x) => x.id === req.params.id);
  if (!c && active && active.id === req.params.id) {
    c = {
      id: active.id,
      to: active.customerNumber,
      from: active.fromNumber,
      status: active.mode,
      live: true,
      durationMs: Date.now() - active.startedAt,
      transcript: active.transcript,
      emotionTags: active.transcript.flatMap((e) => e.tags),
    };
  }
  if (!c) return res.status(404).json({ error: 'not found' });
  if (req.query.text) {
    const lines = c.transcript.map(
      (e) => `[${(e.at / 1000).toFixed(1)}s] ${e.role}.${e.type}${e.text ? ': ' + e.text : ''}${e.tags.length ? '  ⟨emotion: ' + e.tags.join(' ') + '⟩' : ''}`
    );
    return res.type('text/plain').send(lines.join('\n'));
  }
  res.json(c);
});

// One active session at a time.
let active = null;
// Armed lead context for the next VinSolutions-initiated (inbound) call.
let armed = null;
const log = (m) => console.log(`[${active ? active.id : '-'}] ${m}`);

// In-memory breakdown of the most recent calls (newest first).
const callLogs = [];
function pushCallLog(s, reason) {
  callLogs.unshift({
    id: s.id,
    to: s.customerNumber,
    from: s.fromNumber,
    outcome: reason,
    startedAt: new Date(s.startedAt).toISOString(),
    durationMs: Date.now() - s.startedAt,
    transcript: s.transcript,
    emotionTags: s.transcript.flatMap((e) => e.tags),
  });
  while (callLogs.length > 25) callLogs.pop();
}
function callSummary(c) {
  return {
    id: c.id,
    to: c.to,
    from: c.from,
    outcome: c.outcome,
    turns: c.transcript.length,
    emotionTags: c.emotionTags.length,
    durationSec: Math.round(c.durationMs / 1000),
  };
}

function requireSecret(req, res) {
  if (SHARED_SECRET && req.body.secret !== SHARED_SECRET) {
    res.status(401).json({ ok: false, error: 'bad secret' });
    return false;
  }
  return true;
}

// ---- Start an AI call ----
app.post('/start-call', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const customerNumber = (req.body.customerNumber || '').trim();
  if (!customerNumber) return res.status(400).json({ ok: false, error: 'customerNumber required' });
  if (active && active.mode !== 'done') return res.status(409).json({ ok: false, error: 'a call is already active' });

  const id = 's' + Date.now();

  try {
    if (!PUBLIC_HOST) throw new Error('PUBLIC_HOST not set');
    const from = nextNumber(); // throws if TWILIO_NUMBERS is missing

    active = new Session({
      id,
      from,
      customerNumber,
      script: req.body.script || '',
      leadContext: req.body.screenText || '',
      persona: req.body.persona || '',
      repName: req.body.repName || process.env.REP_NAME,
      handoffLine: req.body.handoffLine || process.env.HANDOFF_LINE,
      managerNumber: req.body.managerNumber || process.env.MANAGER_NUMBER || process.env.REP_CELL,
      twilioClient: client,
      onLog: (m) => console.log(`[${id}] ${m}`),
    });
    active.onDone = (reason) => {
      // Snapshot the full call breakdown for retrieval via /calls.
      const s = active;
      callLogs.unshift({
        id: s.id,
        to: s.customerNumber,
        from: s.fromNumber,
        outcome: reason,
        startedAt: new Date(s.startedAt).toISOString(),
        durationMs: Date.now() - s.startedAt,
        transcript: s.transcript,
        emotionTags: s.transcript.flatMap((e) => e.tags),
      });
      while (callLogs.length > 25) callLogs.pop();
      if (pool) {
        pool
          .query(`INSERT INTO calls (session_id, customer_call_sid, outcome, script) VALUES ($1,$2,$3,$4)`, [
            id,
            active && active.customerCallSid,
            reason,
            req.body.script || '',
          ])
          .catch(() => {});
      }
    };

    const base = `https://${PUBLIC_HOST}`;
    const customerCall = await client.calls.create({
      to: customerNumber,
      from,
      url: `${base}/twilio/outbound?sid=${id}`,
      machineDetection: 'DetectMessageEnd',
      asyncAmd: 'true',
      asyncAmdStatusCallback: `${base}/amd?sid=${id}`,
      asyncAmdStatusCallbackMethod: 'POST',
    });

    let repCall = null;
    // Monitor leg is OFF by default (end-state: no always-on monitor; the manager
    // is pulled in only on a warm handoff). Pass {"monitor": true} to opt in.
    const wantMonitor = req.body.monitor === true || String(req.body.monitor) === 'true';
    if (REP_CELL && wantMonitor) {
      repCall = await client.calls.create({
        to: REP_CELL,
        from,
        url: `${base}/twilio/monitor?sid=${id}`,
      });
    }
    active.setCallSids(customerCall.sid, repCall && repCall.sid);
    res.json({ ok: true, sessionId: id, from, customerCallSid: customerCall.sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- TwiML for the two legs ----
function streamTwiml(role, sid) {
  const wsUrl = `wss://${PUBLIC_HOST}/media`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="role" value="${role}"/>
      <Parameter name="sid" value="${sid}"/>
    </Stream>
  </Connect>
</Response>`;
}

app.post('/twilio/outbound', (req, res) => {
  res.type('text/xml').send(streamTwiml('customer', req.query.sid || ''));
});
app.post('/twilio/monitor', (req, res) => {
  res.type('text/xml').send(streamTwiml('rep', req.query.sid || ''));
});

// ---- Path A: VinSolutions click-to-call ----
// The extension arms the lead context, then auto-clicks Dial in VinSolutions.
// VinSolutions rings our Twilio number (set as the agent's dial number); that
// number's Voice webhook points here.
app.post('/arm', (req, res) => {
  if (!requireSecret(req, res)) return;
  armed = {
    customerNumber: (req.body.customerNumber || '').trim(),
    leadContext: req.body.screenText || req.body.leadContext || '',
    script: req.body.script || '',
    persona: req.body.persona || '',
    repName: req.body.repName || '',
    handoffLine: req.body.handoffLine || '',
    armedAt: Date.now(),
  };
  res.json({ ok: true });
});

// Twilio Voice webhook for the AI agent's number. VinSolutions has already
// dialed the customer and bridged us in, so we accept (press 1) and stream.
app.post('/twilio/incoming', (req, res) => {
  const id = 's' + Date.now();
  const a = armed || {};
  let from = null;
  try { from = nextNumber(); } catch {}
  active = new Session({
    id,
    from,
    inbound: true,
    customerNumber: a.customerNumber || req.body.To || null,
    leadContext: a.leadContext || '',
    script: a.script || '',
    persona: a.persona || '',
    repName: a.repName || process.env.REP_NAME,
    handoffLine: a.handoffLine || process.env.HANDOFF_LINE,
    managerNumber: a.managerNumber || process.env.MANAGER_NUMBER || process.env.REP_CELL,
    twilioClient: client,
    onLog: (m) => console.log(`[${id}] ${m}`),
  });
  active.onDone = (reason) => pushCallLog(active, reason);

  const wsUrl = `wss://${PUBLIC_HOST}/media`;
  const digits = process.env.CONNECT_DIGITS ?? 'ww1'; // press 1 to accept VinSolutions' connect prompt
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${digits ? `<Play digits="${digits}"/>` : ''}
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="role" value="customer"/>
      <Parameter name="sid" value="${id}"/>
    </Stream>
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ---- AMD callback: human vs machine ----
app.post('/amd', (req, res) => {
  const sid = req.query.sid;
  if (active && active.id === sid) active.onAmd(req.body.AnsweredBy);
  res.sendStatus(200);
});

// ---- Take Over / Hang Up ----
app.post('/take-over', (req, res) => {
  if (!requireSecret(req, res)) return;
  if (!active || active.mode === 'done') return res.json({ ok: false, error: 'no active call' });
  const ok = active.takeOver();
  res.json({ ok });
});

app.post('/hangup', (req, res) => {
  if (!requireSecret(req, res)) return;
  if (active) active.hangup('manual');
  res.json({ ok: true });
});

// ---- Media-stream WebSocket: route frames to the active session by role ----
const server = http.createServer(app);
// Both sockets use noServer + manual upgrade routing. Attaching two
// WebSocketServers to one HTTP server via the `path` option makes the first one
// abort the other's upgrades with 400 — which silently broke /sim-ws.
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  let role = null;
  let sid = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === 'start') {
      const p = msg.start.customParameters || {};
      role = p.role;
      sid = p.sid;
      if (active && active.id === sid && (role === 'customer' || role === 'rep')) {
        active.attachLeg(role, ws, msg.start.streamSid);
      }
    } else if (msg.event === 'media') {
      if (active && active.id === sid && role) active.onMedia(role, msg.media.payload);
    } else if (msg.event === 'stop') {
      if (active && active.id === sid && role) active.detachLeg(role);
    }
  });

  ws.on('close', () => {
    if (active && active.id === sid && role && active.legs[role] && active.legs[role].ws === ws) {
      active.detachLeg(role);
    }
  });
});

// ---- Simulator WebSocket: drives the real Brain + Fish voice in the browser,
// so you can iterate on the agent (persona, wording, emotion tags, handoff)
// without placing a phone call. Customer turns come as typed text from /sim. ----
const simWss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades to the right server by path.
server.on('upgrade', (req, socket, head) => {
  let pathname = req.url || '';
  const q = pathname.indexOf('?');
  if (q !== -1) pathname = pathname.slice(0, q);
  if (pathname === '/media') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/sim-ws') {
    simWss.handleUpgrade(req, socket, head, (ws) => simWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

simWss.on('connection', (ws) => {
  let brain = null;
  let customer = null;     // the AI customer (auto-play mode)
  let fish = null;         // agent voice
  let custFish = null;     // customer voice (distinct reference_id)
  let stt = null;
  let turning = false;     // a turn is generating/speaking
  let autoRunning = false; // agent-vs-customer auto loop is active
  let micBuffer = '';
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

  const ensureFish = () => {
    if (fish) return;
    // 24 kHz so the voice sounds clean on laptop speakers (telephony is 8 kHz).
    fish = TTS_PROVIDER === 'eleven'
      ? new ElevenTTS({ sampleRate: 24000 })
      : new FishTTS({ sampleRate: 24000 });
    fish.on('audio', (pcmBuf) => { try { ws.send(pcmBuf); } catch {} });
    fish.on('error', (e) => send({ type: 'log', text: `${TTS_PROVIDER} tts error: ` + e.message }));
    fish.connect();
  };

  // Second voice for the AI customer in auto-play. Uses FISH_CUSTOMER_MODEL_ID if
  // set, otherwise no reference_id -> Fish's default voice (distinct from the
  // agent's cloned voice). Both voices stream into the SAME browser audio
  // timeline, which plays them back-to-back, so the turns never overlap.
  const ensureCustomerFish = () => {
    if (custFish) return;
    custFish = new FishTTS({
      sampleRate: 24000,
      referenceId: process.env.FISH_CUSTOMER_MODEL_ID || null,
    });
    custFish.on('audio', (pcmBuf) => { try { ws.send(pcmBuf); } catch {} });
    custFish.on('error', (e) => send({ type: 'log', text: 'cust fish error: ' + e.message }));
    custFish.connect();
  };

  // Strip emotion/stage-direction tags + control tokens, for speech-time estimate
  // and for the text we feed to the other brain.
  const plain = (t) => (t || '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\[[^\]\n]*\]/g, '').replace(/\([^)\n]*\)/g, '').replace(/\s+/g, ' ').trim();
  // Rough spoken-duration estimate so the auto loop paces with the audio instead
  // of racing ahead. ~14 chars/sec ≈ 150 wpm, plus a short gap between turns.
  const speakMs = (t) => Math.min(14000, Math.max(1200, Math.round(plain(t).length / 14 * 1000)) + 500);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const turn = async (producer) => {
    turning = true;
    let full = '';
    try {
      await producer((tok) => { full += tok; send({ type: 'agent_token', text: tok }); });
    } catch (e) {
      send({ type: 'log', text: 'brain error: ' + e.message });
      turning = false;
      return;
    }
    if (/\[\[\s*HANDOFF/i.test(full)) { send({ type: 'handoff' }); turning = false; return; }
    ensureFish();
    fish.pushText(full);
    fish.flush();
    send({ type: 'agent_done', text: full, tags: simTags(full) });
    turning = false;
  };

  // One side's turn in auto-play. role: 'agent' | 'customer'. Streams tokens to
  // the matching bubble, voices through the matching Fish, and paces to the
  // estimated speech duration. Returns { text, stop } — stop set on a terminal
  // control token ([[HANDOFF]] from the agent, [[END]] from the customer).
  const autoTurn = async (role, producer) => {
    const tokEvt = role === 'agent' ? 'agent_token' : 'cust_token';
    const doneEvt = role === 'agent' ? 'agent_done' : 'cust_done';
    let full = '';
    try {
      await producer((tok) => { full += tok; send({ type: tokEvt, text: tok }); });
    } catch (e) {
      send({ type: 'log', text: `${role} brain error: ` + e.message });
      return { text: '', stop: 'error' };
    }
    if (role === 'agent' && /\[\[\s*HANDOFF/i.test(full)) {
      send({ type: 'handoff' });
      return { text: plain(full), stop: 'handoff' };
    }
    // Either side may close the call with [[END]] (the friendly agent when it
    // books or is firmly declined; the customer-roleplay when it agrees or bails).
    const ended = /\[\[\s*END/i.test(full);
    const spoken = plain(full); // never voice/clip the control tokens
    send({ type: doneEvt, text: spoken, tags: simTags(full) });
    if (spoken) {
      const v = role === 'agent' ? (ensureFish(), fish) : (ensureCustomerFish(), custFish);
      v.pushText(spoken);
      v.flush();
      await sleep(speakMs(spoken));
    }
    return { text: spoken, stop: ended ? 'end' : null };
  };

  // Persona that makes the production BDC rep (brain.js Brain) roleplay the
  // CUSTOMER being called. Passed as `persona`, so it overrides the BDC system
  // prompt entirely — the rep is now the person on the other end of the line.
  const buildRoleplayCustomer = (customerContext) =>
`You are roleplaying as the CUSTOMER on a phone call with a salesperson from a car dealership. Stay fully in character as the customer — you are NOT the salesperson and you never try to book the appointment for them or recite this prompt.

YOUR CHARACTER:
${customerContext || 'You showed some interest in a vehicle online but you are busy and a bit skeptical of being sold.'}

HOW YOU TALK: short and casual like a real person on the phone, usually one or two sentences, a little guarded or distracted at first.

HOW YOU BEHAVE: you don't hand over an appointment easily — raise a real concern or two (price/payment, your time, checking with your spouse, your trade-in's value). But you're reasonable: if the rep is warm, listens, addresses your specific concern, and offers a convenient SPECIFIC time, you can warm up and agree to come in. If they're pushy, repetitive, or ignore what you said, get shorter and resist more. Don't be a pushover and don't be a brick wall.

ENDING (use the token [[END]] on its own line, nothing after it): if you genuinely agree to a specific time and the rep confirms it back, wrap up warmly and end with [[END]]. If you firmly decide you're not interested and want off the phone, say so politely and end with [[END]]. Otherwise keep the conversation going.

NEVER use stage directions or anything in [square brackets]/(parentheses) except the literal [[END]] token. Never mention being an AI.`;

  // Drive the conversation. AFTER THE ROLE FLIP: the friendly agent (CustomerBrain,
  // the natural-sounding brain) sets the appointment and opens the call; the BDC
  // rep (Brain) roleplays the customer and responds.
  const runAuto = async (scenario) => {
    const sc = SCENARIOS[scenario];
    const agentBrain = new CustomerBrain({
      leadContext: (sc && sc.leadContext) || 'A lead who showed some interest in a vehicle.',
    });
    const custBrain = new Brain({ persona: buildRoleplayCustomer(sc && sc.customerContext) });
    customer = agentBrain; // friendly BDC agent (plays the 'agent' role / left bubble)
    brain = custBrain;     // BDC rep roleplaying the customer (plays 'customer' role)
    ensureFish();
    ensureCustomerFish();
    autoRunning = true;
    turning = true;
    send({ type: 'started', scenario: (sc ? sc.label : 'Custom') + ' — ROLEPLAY (agent ↔ customer)', styleRefs: styleRefs.length, auto: true });

    try {
      // The friendly agent opens (outbound — the rep speaks first).
      let last = await autoTurn('agent', (t) => agentBrain.greet(t));
      if (last.stop) { send({ type: 'auto_done', reason: last.stop }); return; }

      const MAX_EXCHANGES = 16;
      for (let i = 0; i < MAX_EXCHANGES && autoRunning; i++) {
        const cust = await autoTurn('customer', (t) => custBrain.respond(last.text, t));
        if (!autoRunning) break;
        if (cust.stop) { send({ type: 'auto_done', reason: cust.stop }); return; }

        last = await autoTurn('agent', (t) => agentBrain.respond(cust.text, t));
        if (!autoRunning) break;
        if (last.stop) { send({ type: 'auto_done', reason: last.stop }); return; }
      }
      send({ type: 'auto_done', reason: autoRunning ? 'max_turns' : 'stopped' });
    } catch (e) {
      send({ type: 'log', text: 'auto error: ' + e.message });
      send({ type: 'auto_done', reason: 'error' });
    } finally {
      autoRunning = false;
      turning = false;
    }
  };

  // Mic mode: browser streams linear16 16k PCM; Deepgram detects end-of-turn.
  const startMic = () => {
    if (stt) return;
    if (!brain) brain = new Brain({ leadContext: 'Internet lead.' });
    stt = new DeepgramSTT({ encoding: 'linear16', sampleRate: 16000 });
    stt.start();
    const fire = () => {
      const said = micBuffer.trim();
      micBuffer = '';
      if (said && !turning) { send({ type: 'customer', text: said }); turn((t) => brain.respond(said, t)); }
    };
    stt.on('transcript', (text, isFinal, speechFinal) => {
      if (isFinal && text) micBuffer += (micBuffer ? ' ' : '') + text;
      if (speechFinal) fire();
    });
    stt.on('utteranceEnd', () => fire());
    stt.on('error', (e) => send({ type: 'log', text: 'stt error: ' + e.message }));
    send({ type: 'mic_ready' });
  };

  ws.on('message', async (raw, isBinary) => {
    // ws delivers BOTH text and binary as Buffers — distinguish by isBinary.
    // Binary frames = mic PCM (linear16 16k) -> Deepgram. Text = JSON control.
    if (isBinary) {
      if (stt) stt.send(Buffer.from(raw));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'start') {
      if (autoRunning) autoRunning = false; // a manual start cancels any auto loop
      const sc = SCENARIOS[msg.scenario];
      brain = new Brain({
        leadContext:
          (sc && sc.leadContext) || msg.leadContext || 'Internet lead interested in a vehicle; has not been into the store yet.',
        styleGuidance: styleGuidance || undefined,
      });
      ensureFish();
      send({ type: 'started', scenario: sc ? sc.label : 'Custom', styleRefs: styleRefs.length });
      await turn((onTok) => brain.greet(onTok));
    } else if (msg.type === 'auto_start') {
      if (autoRunning || turning) return; // one conversation at a time
      await runAuto(msg.scenario);
    } else if (msg.type === 'auto_stop') {
      autoRunning = false;
    } else if (msg.type === 'say') {
      if (!brain) brain = new Brain({ leadContext: 'Internet lead.' });
      send({ type: 'customer', text: msg.text });
      await turn((onTok) => brain.respond(msg.text, onTok));
    } else if (msg.type === 'mic_start') {
      startMic();
    } else if (msg.type === 'mic_stop') {
      if (stt) { stt.close(); stt = null; }
    } else if (msg.type === 'handoff') {
      send({ type: 'handoff' });
    } else if (msg.type === 'reset') {
      autoRunning = false;
      brain = null;
      customer = null;
      micBuffer = '';
      send({ type: 'reset_ok' });
    }
  });

  ws.on('close', () => { autoRunning = false; if (fish) fish.close(); if (custFish) custFish.close(); if (stt) stt.close(); brain = null; customer = null; });
});

server.listen(PORT, () => console.log(`listening on ${PORT}`));
