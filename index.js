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
const path = require('path');
const express = require('express');
const db = require('./db');
const dispatcher = require('./dispatcher');
let AGENTS = {};
try { AGENTS = require('./agents.json'); } catch { /* no agent registry */ }

const { PORT = 3000, SHARED_SECRET = '', WEBHOOK_SECRET = '' } = process.env;

const app = express();
app.use(express.json({ limit: '25mb' })); // big lead batches (full comms history per lead)
app.use(express.urlencoded({ extended: false, limit: '25mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

// Secret check for campaign endpoints (accepts body.secret or ?secret=).
function badSecret(req) {
  if (!SHARED_SECRET) return false;
  const s = (req.body && typeof req.body === 'object' && req.body.secret) || req.query.secret;
  return s !== SHARED_SECRET;
}

// Lead context for the NEXT Eleven-handled call. Overwritten by each /arm.
// In-memory and single-slot — matches the one-call-at-a-time dialer workflow.
let armed = null;

app.get('/', (_req, res) => res.send('Eleven lead-context webhook up'));

// Browser simulator: embeds the ElevenLabs ConvAI widget so you can talk to the
// live agent (Jake) with no phone. Faithful to what's on the Twilio line.
app.get('/sim', (_req, res) => res.sendFile(path.join(__dirname, 'sim.html')));

// Outbound campaign operator console (run a block by hand: paced deep links + outcomes).
app.get('/campaign', (_req, res) => res.sendFile(path.join(__dirname, 'campaign.html')));

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
  process.env.ELEVEN_INBOUND_URL || 'https://api.elevenlabs.io/twilio/inbound_call';
// 'w' = 0.5s pause in Twilio <Play digits>. VinSolutions' "press 1 to connect"
// prompt doesn't start at exactly the same moment each call, so a single press
// (ww1) sometimes lands outside its listening window -> no bridge -> dead air.
// Press 1 at ~1s, ~2s, and ~3s to cover the timing variance. Extra presses after
// the bridge are harmless DTMF.
const CONNECT_DIGITS = process.env.CONNECT_DIGITS ?? 'ww1ww1ww1';
// Wait this long AFTER pressing 1 (which triggers VinSolutions to dial the
// customer) before handing the leg to the Eleven agent — so the agent greets
// once the customer is actually bridged on, not into an empty bridge. Tune via
// CONNECT_PAUSE_SEC on Render to match your typical answer time.
const CONNECT_PAUSE = Number(process.env.CONNECT_PAUSE_SEC ?? 0);

app.post('/twilio/vinsolutions', (_req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${CONNECT_DIGITS ? `<Play digits="${CONNECT_DIGITS}"/>` : ''}
  ${CONNECT_PAUSE > 0 ? `<Pause length="${CONNECT_PAUSE}"/>` : ''}
  <Redirect method="POST">${ELEVEN_INBOUND_URL}</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// ========================================================================
// Outbound campaign (Dana): report CSV -> worklist -> paced dispatcher
// ========================================================================

// Minimal RFC-ish CSV parser (handles quoted fields, commas, CRLF).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => (x || '').trim() !== ''));
}

const HEADER_ALIASES = {
  gcid: 'gcid', globalcustomerid: 'gcid', globalcustomer: 'gcid', customerid: 'gcid', gcustomerid: 'gcid',
  leadid: 'leadId', autoleadid: 'leadId', lead: 'leadId',
  name: 'name', customername: 'name', fullname: 'name', customer: 'name',
  phone: 'phone', cell: 'phone', mobile: 'phone', phonenumber: 'phone', primaryphone: 'phone', cellphone: 'phone',
  vehicle: 'vehicle', car: 'vehicle', vehicleofinterest: 'vehicle', soldvehicle: 'vehicle', purchasedvehicle: 'vehicle',
  context: 'context', summary: 'context',
  history: 'history', notes: 'history', comments: 'history', comms: 'history', communication: 'history',
  communications: 'history', communicationlog: 'history', commlog: 'history', commshistory: 'history',
  commhistory: 'history', communicationhistory: 'history', contacthistory: 'history', callhistory: 'history',
  activity: 'history', activitylog: 'history', messages: 'history', messagelog: 'history', log: 'history',
  saledate: 'sale_date', solddate: 'sale_date', purchasedate: 'sale_date', date: 'sale_date',
};
const mapHeader = (h) => HEADER_ALIASES[String(h).toLowerCase().replace(/[^a-z0-9]/g, '')] || null;

// Auto lead_context by campaign type. A `context` column overrides the template;
// a `history`/comms column is appended so the agent has full prior-contact context.
function buildContext(o, type) {
  const v = o.vehicle ? `a ${o.vehicle}` : 'a vehicle';
  let base = o.context;
  if (!base) {
    switch (type) {
      case 'internet_lead':
        base = `Fresh internet lead — submitted an online inquiry about ${v} and has not been contacted yet. Reach out warmly, introduce yourself, confirm they're still interested, and set a specific appointment to come see it. Don't quote price; build value in the in-person visit.`; break;
      case 'no_show':
        base = `Missed a scheduled appointment to see ${v}. Be gracious — assume life got busy — and make rescheduling easy by offering a specific new time. No guilt trip.`; break;
      case 'previously_sold':
        base = `Existing customer who previously purchased ${v}${o.sale_date ? ` (${o.sale_date})` : ''} from the dealership. Friendly owner follow-up — check in and gently surface any upgrade or trade opportunity. Don't quote numbers; drive to a visit or hand to sales.`; break;
      default:
        base = `Lead interested in ${v}. Reach out warmly and work toward setting a specific appointment to come in. Don't quote price; build value in the visit.`;
    }
  }
  if (o.history) {
    // Cap to keep the context tight and within Eleven's dynamic-variable limits.
    const hist = String(o.history).slice(0, 6000);
    base += `\n\nPrior communication history with this customer (use it to sound informed and pick up naturally where things left off — do not read it back):\n${hist}`;
  }
  return base;
}

function rowsToLeads(rows, source, type) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(mapHeader);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const o = {};
    headers.forEach((key, idx) => { if (key) o[key] = (rows[i][idx] || '').trim(); });
    if (!o.gcid) continue;
    out.push({ gcid: o.gcid, leadId: o.leadId, name: o.name, phone: o.phone, vehicle: o.vehicle, context: buildContext(o, type), situation: type, source });
  }
  return out;
}

function normalizeJsonLead(o, type) {
  const gcid = o.gcid || o.globalCustomerId || o.global_customer_id || o.customerId;
  return {
    gcid, leadId: o.leadId || o.lead_id || o.leadID || o.autoLeadId,
    name: o.name || o.customerName, phone: o.phone, vehicle: o.vehicle,
    context: buildContext({ vehicle: o.vehicle, sale_date: o.saleDate || o.sale_date, context: o.context, history: o.history }, type),
    situation: type, source: o.source || 'json',
  };
}

// Load a report into the worklist. Accepts JSON { leads:[...] } or { csv:"..." }
// or a raw text/csv body (with ?secret=).
app.post('/campaign/ingest', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  try {
    const type = (req.body && typeof req.body === 'object' && req.body.type) || req.query.type || 'internet_lead';
    let leads = [];
    if (req.body && Array.isArray(req.body.leads)) leads = req.body.leads.map((o) => normalizeJsonLead(o, type));
    else {
      const csvText = (req.body && req.body.csv) || (typeof req.body === 'string' ? req.body : '');
      if (!csvText) return res.status(400).json({ ok: false, error: 'provide leads[] or csv text' });
      leads = rowsToLeads(parseCsv(csvText), (req.body && req.body.source) || 'csv:report', type);
    }
    let added = 0, updated = 0, skipped = 0;
    for (const l of leads) { const r = await db.upsertLead(l); r === 'added' ? added++ : r === 'updated' ? updated++ : skipped++; }
    res.json({ ok: true, parsed: leads.length, added, updated, skipped, stats: await db.stats() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Agent registry for the console dropdown (labels + lead types; agent IDs are not secret).
app.get('/campaign/agents', (req, res) => {
  if (badSecret(req)) return res.status(401).json({ error: 'bad secret' });
  const out = {};
  for (const [k, a] of Object.entries(AGENTS)) out[k] = { label: a.label, leadTypes: a.leadTypes || [], apiReady: !!(a.agentId && a.phoneNumberId), notes: a.notes || '' };
  res.json(out);
});

app.post('/campaign/start', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  try {
    const opts = { ...(req.body || {}) };
    const a = opts.agent && AGENTS[opts.agent];
    if (a) { opts.agentId = a.agentId; opts.phoneNumberId = a.phoneNumberId; opts.agentLabel = a.label; }
    res.json({ ok: true, status: await dispatcher.start(opts), stats: await db.stats() });
  } catch (e) { res.status(409).json({ ok: false, error: e.message }); }
});

app.post('/campaign/stop', (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  res.json({ ok: true, status: dispatcher.stop('manual') });
});

app.get('/campaign/status', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  res.json({ status: dispatcher.status(), stats: await db.stats() });
});

// Browser worker pulls the next paced batch of due contacts (deeplink mode).
app.get('/campaign/next', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ error: 'bad secret' });
  try { res.json(await dispatcher.next(req.query.max || 5)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Worker reports a call's outcome back to the worklist.
app.post('/campaign/result', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  const { gcid, status, outcome, nextTouchAt } = req.body || {};
  if (!gcid || !status) return res.status(400).json({ ok: false, error: 'gcid and status required' });
  await db.recordOutcome(gcid, { status, outcome, nextTouchAt: nextTouchAt ? new Date(nextTouchAt) : null });
  res.json({ ok: true });
});

app.post('/campaign/suppress', async (req, res) => {
  if (badSecret(req)) return res.status(401).json({ ok: false, error: 'bad secret' });
  const { gcid, phone, reason } = req.body || {};
  if (!gcid && !phone) return res.status(400).json({ ok: false, error: 'gcid or phone required' });
  res.json({ ok: await db.suppress({ gcid, phone }, reason || 'manual') });
});

// ElevenLabs post-call webhook (best-effort): close the loop on outcomes + opt-outs.
app.post('/eleven/postcall', async (req, res) => {
  try {
    const b = req.body || {};
    console.log('[postcall] raw:', JSON.stringify(b).slice(0, 800));
    const data = b.data || b;
    const pc = (data.metadata && data.metadata.phone_call) || {};
    const phone = pc.external_number || pc.to_number || null;
    const success = data.analysis ? data.analysis.call_successful : undefined;
    const optOut = /\b(stop|do ?not ?call|don'?t call|take me off|remove me|unsubscribe)\b/i.test(JSON.stringify(data.transcript || ''));
    const gcid = phone ? await db.gcidForPhone(phone) : null;
    if (gcid) {
      if (optOut) await db.suppress({ gcid }, 'opt_out_on_call');
      else await db.recordOutcome(gcid, { status: 'completed', outcome: typeof success === 'string' ? success : success === true ? 'success' : 'completed' });
    }
  } catch (e) { console.error('[postcall]', e.message); }
  res.sendStatus(200);
});

db.init().catch((e) => console.error('[db] init error:', e.message));
app.listen(PORT, () => console.log(`lead-context webhook + campaign dispatcher listening on ${PORT}`));
