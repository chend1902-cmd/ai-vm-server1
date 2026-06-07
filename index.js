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
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');

const { Session } = require('./session');
const { nextNumber } = require('./numbers');

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

// One active session at a time.
let active = null;
const log = (m) => console.log(`[${active ? active.id : '-'}] ${m}`);

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
      script: req.body.script || '',
      leadContext: req.body.screenText || '',
      persona: req.body.persona || '',
      repName: req.body.repName || process.env.REP_NAME,
      handoffLine: req.body.handoffLine || process.env.HANDOFF_LINE,
      twilioClient: client,
      onLog: (m) => console.log(`[${id}] ${m}`),
    });
    active.onDone = (reason) => {
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
    if (REP_CELL) {
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
const wss = new WebSocketServer({ server, path: '/media' });

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

server.listen(PORT, () => console.log(`listening on ${PORT}`));
