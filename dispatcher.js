// Campaign dispatcher for Dana — the paced "auto BDC manager" that turns a loaded
// worklist into worked contacts over a time block.
//
// Two dispatch modes:
//   'deeplink'   — RECOMMENDED. Releases due contacts (with their GCID deep link)
//                  to a browser worker via GET /campaign/next. The worker opens the
//                  deep link and 1-clicks dial in VinSolutions → press-1 shim → Dana.
//                  VinSolutions originates the call, so it's auto-logged + history is
//                  on-screen to scrape as context.
//   'eleven_api' — Server calls ElevenLabs' Twilio outbound API directly (needs a
//                  Dana agent + phone number). Fully autonomous, but NOT logged in
//                  VinSolutions.
//
// Pacing is a token bucket (paces both modes). Dry-run by default — no real calls
// or releases dial until you start with { dryRun: false }.

const db = require('./db');

const TICK_MS = 5000;
const ELEVEN_OUTBOUND_URL = 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';

let C = null; // single active campaign (one block at a time)

function localHour(tz) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())); }
  catch { return new Date().getHours(); }
}
function withinCallingHours() {
  const tz = process.env.CAMPAIGN_TZ || 'America/New_York';
  const start = Number(process.env.CALLING_HOURS_START || 9);
  const end = Number(process.env.CALLING_HOURS_END || 20);
  const h = localHour(tz);
  return h >= start && h < end;
}

function status() {
  if (!C) return { running: false };
  return {
    running: C.running, mode: C.mode, dryRun: C.dryRun,
    startedAt: C.startedAt, endsAt: C.endsAt,
    pacePerMinute: C.pacePerMinute, maxCalls: C.maxCalls, launched: C.launched,
    focus: C.focus || '', bucket: Math.floor(C.bucket), withinCallingHours: withinCallingHours(),
  };
}

async function start(opts = {}) {
  if (C && C.running) throw new Error('a campaign is already running');
  const durationMinutes = Number(opts.durationMinutes || 120);
  const pacePerMinute = Number(opts.pacePerMinute || 10);
  const mode = opts.mode || process.env.DISPATCH_MODE || 'deeplink';
  const dryRun = opts.dryRun !== false; // DRY RUN unless explicitly false
  const maxCalls = Number(opts.maxCalls || pacePerMinute * durationMinutes);
  // Per-session strategy/hook injected into every call's context this block only.
  const focus = (opts.focus || '').toString().trim();
  const now = Date.now();
  C = {
    running: true, mode, dryRun, pacePerMinute, maxCalls, focus,
    startedAt: new Date(now).toISOString(), endsAt: new Date(now + durationMinutes * 60000).toISOString(),
    _endMs: now + durationMinutes * 60000, launched: 0, bucket: Math.min(1, pacePerMinute), timer: null,
  };
  C.timer = setInterval(() => tick().catch((e) => console.error('[dispatch] tick error', e.message)), TICK_MS);
  console.log(`[dispatch] start mode=${mode} dryRun=${dryRun} pace=${pacePerMinute}/min cap=${maxCalls} window=${durationMinutes}min`);
  tick().catch((e) => console.error('[dispatch] tick error', e.message)); // prime the bucket / dispatch immediately
  return status();
}

function stop(reason = 'manual') {
  if (C && C.timer) clearInterval(C.timer);
  if (C) C.running = false;
  console.log(`[dispatch] stop (${reason})`);
  return status();
}

async function tick() {
  if (!C || !C.running) return;
  if (Date.now() >= C._endMs) return void stop('window_complete');
  // Rescue contacts stuck in 'dialing' (claimed but never reported back).
  await db.requeueStale(Number(process.env.DIALING_TIMEOUT_MIN || 10)).catch(() => {});
  // refill the pacing bucket (burst capped at ~1 minute of pace)
  C.bucket = Math.min(C.pacePerMinute, C.bucket + C.pacePerMinute * (TICK_MS / 60000));
  if (!withinCallingHours()) return;        // paused outside legal hours (window still counts down)
  if (C.launched >= C.maxCalls) return void stop('cap_reached');
  if (C.mode !== 'eleven_api') return;      // deeplink mode releases via next(), not the tick

  const allot = Math.min(Math.floor(C.bucket), C.maxCalls - C.launched);
  if (allot < 1) return;
  const due = await db.claimDue(allot);
  for (const lead of due) { C.bucket -= 1; C.launched += 1; await dispatchEleven(lead); }
}

function toJob(lead) {
  const focus = C && C.focus ? C.focus : '';
  // Fold the session strategy into lead_context so it reaches the agent through the
  // existing {{lead_context}} variable — no ElevenLabs prompt change required.
  const lead_context = (focus ? `SESSION STRATEGY — lead with this angle as the primary hook for this call: ${focus}\n\n` : '') + (lead.context || '');
  return {
    gcid: lead.gcid, name: lead.name, phone: lead.phone, deep_link: lead.deep_link,
    dynamic_variables: { customer_name: lead.name || '', vehicle: lead.vehicle || '', lead_context },
  };
}

// Pull-based release for the deeplink/browser-worker path. Returns paced, already-
// claimed ('dialing') contacts for the worker to open + click.
async function next(max = 5) {
  if (!C || !C.running) return { running: false, leads: [] };
  if (!withinCallingHours()) return { running: true, paused: 'calling_hours', leads: [] };
  if (C.launched >= C.maxCalls) { stop('cap_reached'); return { running: false, leads: [] }; }
  const allot = Math.min(Number(max) || 5, Math.floor(C.bucket), C.maxCalls - C.launched);
  if (allot < 1) return { running: true, leads: [] };
  const due = await db.claimDue(allot);
  C.bucket -= due.length; C.launched += due.length;
  return { running: true, leads: due.map(toJob) };
}

async function dispatchEleven(lead) {
  const agentId = process.env.DANA_AGENT_ID;
  const phoneId = process.env.DANA_PHONE_NUMBER_ID;
  const key = process.env.ELEVEN_API_KEY;
  if (C.dryRun || !agentId || !phoneId || !key || !lead.phone) {
    console.log(`[dispatch][DRY] call ${lead.name || lead.gcid} ${lead.phone || '(no phone)'} | ${(lead.context || '').slice(0, 80)}`);
    await db.recordOutcome(lead.gcid, { status: 'dry_run', outcome: 'dry-run dispatch' });
    return;
  }
  try {
    const r = await fetch(ELEVEN_OUTBOUND_URL, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId, agent_phone_number_id: phoneId, to_number: lead.phone,
        conversation_initiation_client_data: { dynamic_variables: toJob(lead).dynamic_variables },
      }),
    });
    const body = await r.text();
    if (r.status >= 400) { console.error('[dispatch] eleven error', r.status, body.slice(0, 300)); await db.recordOutcome(lead.gcid, { status: 'failed', outcome: `eleven ${r.status}` }); return; }
    console.log(`[dispatch] dialed ${lead.phone}`);
    // leave status 'dialing'; the post-call webhook moves it to a terminal state
  } catch (e) {
    console.error('[dispatch] dial exception', e.message);
    await db.recordOutcome(lead.gcid, { status: 'failed', outcome: e.message });
  }
}

module.exports = { start, stop, status, next, withinCallingHours };
