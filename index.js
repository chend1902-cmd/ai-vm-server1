// Lead-context webhook for the ElevenLabs Conversational AI agent.
//
// The heavy lifting (STT -> LLM -> TTS -> turn-taking) now runs INSIDE
// ElevenLabs, connected to Twilio via Eleven's native integration. This server
// has exactly one job: hold the "armed" lead context and hand it to the Eleven
// agent at the start of each call so it can greet with the specific vehicle/lead.
//
// Flow:
//   1. The browser extension POSTs /arm with the lead (name, vehicle, context).
//   2. VinSolutions click-to-call dials the customer; Twilio routes the call to
//      the Eleven agent (native integration — NOT this server).
//   3. Eleven POSTs /eleven/personalization (the conversation-initiation webhook).
//      We return dynamic_variables (the armed lead), which fill {{placeholders}}
//      in the agent's system prompt / first message.
//
// Configure in ElevenLabs: Agent -> Security/Advanced -> "Fetch conversation
// initiation data" webhook -> https://<this-host>/eleven/personalization

require('dotenv').config();
const express = require('express');

const { PORT = 3000, SHARED_SECRET = '', WEBHOOK_SECRET = '' } = process.env;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Lead context for the NEXT Eleven-handled call. Overwritten by each /arm.
// In-memory and single-slot — matches the one-call-at-a-time dialer workflow.
let armed = null;

app.get('/', (_req, res) => res.send('Eleven lead-context webhook up'));

// ---- Arm the next call's lead context (called by the browser extension) ----
app.post('/arm', (req, res) => {
  if (SHARED_SECRET && req.body.secret !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  armed = {
    customerNumber: (req.body.customerNumber || '').trim() || null,
    customerName: req.body.customerName || req.body.name || '',
    vehicle: req.body.vehicle || '',
    leadContext: req.body.screenText || req.body.leadContext || '',
    armedAt: Date.now(),
  };
  console.log('[arm]', JSON.stringify(armed));
  res.json({ ok: true, armed });
});

// ---- ElevenLabs conversation-initiation (personalization) webhook ----
// Eleven POSTs here when a call starts. We return dynamic variables that the
// agent injects into its prompt / first message via {{var}} placeholders.
// We log the raw request so the exact field names Eleven sends (caller_id,
// called_number, call_sid, ...) can be confirmed on the first real call.
app.post('/eleven/personalization', (req, res) => {
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'bad secret' });
  }
  console.log('[eleven init] request:', JSON.stringify(req.body));

  const a = armed || {};
  const dynamic_variables = {
    lead_context: a.leadContext || 'No specific lead context was provided for this call.',
    customer_name: a.customerName || '',
    vehicle: a.vehicle || '',
  };

  const payload = { type: 'conversation_initiation_client_data', dynamic_variables };

  // Optional: override the agent's opening line with a lead-specific greeting.
  // Requires enabling the first_message override in the Eleven agent's security
  // settings; off by default so dynamic_variables alone (which need no override)
  // are the personalization path.
  if (process.env.ELEVEN_OVERRIDE_FIRST_MESSAGE === 'true' && a.vehicle) {
    const name = process.env.AGENT_NAME || 'Sam';
    payload.conversation_config_override = {
      agent: { first_message: `Hey, this is ${name} over at the dealership — you were looking at that ${a.vehicle}, right?` },
    };
  }

  console.log('[eleven init] response:', JSON.stringify(payload));
  res.json(payload);
});

// ---- VinSolutions click-to-call shim ----
// VinSolutions rings this number and plays a "press 1 to connect" prompt before
// it bridges the customer in. ElevenLabs' native integration just answers and
// never presses 1, so the customer never gets bridged (dead air). We own the
// webhook instead: press 1 (ww1 = wait, wait, send "1"), then hand the now-
// bridged call straight to the Eleven agent's native inbound endpoint.
//
// Point the Twilio number's Voice webhook here instead of at Eleven directly.
const ELEVEN_INBOUND_URL =
  process.env.ELEVEN_INBOUND_URL || 'https://api.us.elevenlabs.io/twilio/inbound_call';
const CONNECT_DIGITS = process.env.CONNECT_DIGITS ?? 'ww1';

app.post('/twilio/vinsolutions', (_req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${CONNECT_DIGITS ? `<Play digits="${CONNECT_DIGITS}"/>` : ''}
  <Redirect method="POST">${ELEVEN_INBOUND_URL}</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

app.listen(PORT, () => console.log(`lead-context webhook listening on ${PORT}`));
