// Worklist storage for outbound campaigns (Dana).
//
// Keyed on the VinSolutions **Global Customer ID (GCID)** — the stable identity
// in every report. Phone is a field (for the direct-dial path); deep_link is the
// 1-click VinSolutions dial URL built from the GCID (for the click-to-call path).
//
// Uses Postgres (Neon) when DATABASE_URL is set — the right choice for a real
// campaign that must survive restarts. Falls back to an in-memory store
// (process-lifetime only) so you can test the whole flow with no DB.

const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
const mem = new Map(); // gcid -> row (in-memory backend)
let memId = 1;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worklist (
  id bigserial PRIMARY KEY,
  gcid text UNIQUE NOT NULL,
  lead_id text,
  phone text,
  deep_link text,
  name text,
  vehicle text,
  context text,
  situation text,
  source text,
  status text NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  suppressed boolean NOT NULL DEFAULT false,
  outcome text,
  last_dispatched_at timestamptz,
  next_touch_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worklist_due ON worklist (status, suppressed, next_touch_at);
`;

async function init() {
  if (USE_PG) await pool.query(SCHEMA);
  console.log(`[db] backend = ${USE_PG ? 'postgres' : 'in-memory (NOT durable — set DATABASE_URL for production)'}`);
}

// US-centric E.164 normalization. Returns null if it can't make a 10/11-digit number.
function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 10) d = '1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

// Build the 1-click VinSolutions "Log Call" deep link. Default is the real
// VinSolutions LogCallV2 URL (needs AutoLeadID + GlobalCustomerID); override with
// DEEPLINK_TEMPLATE using {leadId} and {gcid} placeholders.
const DEFAULT_DEEPLINK =
  'https://vinsolutions.app.coxautoinc.com/CarDashboard/Pages/LeadManagement/LogCallV2/LogCallV2.aspx?AutoLeadID={leadId}&GlobalCustomerID={gcid}&V2Redirect=2';
function buildDeepLink(gcid, leadId) {
  if (!gcid && !leadId) return null;
  const tpl = process.env.DEEPLINK_TEMPLATE || DEFAULT_DEEPLINK;
  return tpl
    .replace(/\{gcid\}/gi, encodeURIComponent(gcid || ''))
    .replace(/\{leadid\}/gi, encodeURIComponent(leadId || ''));
}

// Insert or refresh a contact (dedup on GCID). Re-uploading a report re-queues
// non-suppressed contacts (resets status/attempts); suppressed contacts stay so.
async function upsertLead(lead) {
  const gcid = (lead.gcid || '').toString().trim();
  if (!gcid) return 'skipped';
  const leadId = (lead.leadId || lead.lead_id || '').toString().trim() || null;
  const row = {
    gcid,
    lead_id: leadId,
    phone: normalizePhone(lead.phone),
    deep_link: lead.deep_link || buildDeepLink(gcid, leadId),
    name: lead.name || null,
    vehicle: lead.vehicle || null,
    context: lead.context || null,
    situation: lead.situation || 'followup',
    source: lead.source || null,
  };

  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO worklist (gcid, lead_id, phone, deep_link, name, vehicle, context, situation, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (gcid) DO UPDATE SET
         lead_id = COALESCE(EXCLUDED.lead_id, worklist.lead_id),
         phone = COALESCE(EXCLUDED.phone, worklist.phone),
         deep_link = COALESCE(EXCLUDED.deep_link, worklist.deep_link),
         name = COALESCE(EXCLUDED.name, worklist.name),
         vehicle = COALESCE(EXCLUDED.vehicle, worklist.vehicle),
         context = COALESCE(EXCLUDED.context, worklist.context),
         situation = EXCLUDED.situation,
         source = EXCLUDED.source,
         status = CASE WHEN worklist.suppressed THEN worklist.status ELSE 'queued' END,
         attempts = CASE WHEN worklist.suppressed THEN worklist.attempts ELSE 0 END,
         next_touch_at = CASE WHEN worklist.suppressed THEN worklist.next_touch_at ELSE now() END,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [row.gcid, row.lead_id, row.phone, row.deep_link, row.name, row.vehicle, row.context, row.situation, row.source]
    );
    return r.rows[0].inserted ? 'added' : 'updated';
  }

  const existing = mem.get(gcid);
  if (existing) {
    Object.assign(existing, {
      lead_id: row.lead_id ?? existing.lead_id,
      phone: row.phone ?? existing.phone,
      deep_link: row.deep_link ?? existing.deep_link,
      name: row.name ?? existing.name,
      vehicle: row.vehicle ?? existing.vehicle,
      context: row.context ?? existing.context,
      situation: row.situation,
      source: row.source,
      updated_at: new Date(),
    });
    if (!existing.suppressed) { existing.status = 'queued'; existing.attempts = 0; existing.next_touch_at = new Date(); }
    return 'updated';
  }
  mem.set(gcid, {
    id: memId++, ...row, status: 'queued', attempts: 0, max_attempts: 3,
    suppressed: false, outcome: null, last_dispatched_at: null,
    next_touch_at: new Date(), created_at: new Date(), updated_at: new Date(),
  });
  return 'added';
}

// Atomically claim up to `limit` due contacts and mark them 'dialing'.
async function claimDue(limit) {
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE worklist SET status='dialing', attempts=attempts+1, last_dispatched_at=now(), updated_at=now()
       WHERE id IN (
         SELECT id FROM worklist
         WHERE status='queued' AND suppressed=false AND next_touch_at <= now() AND attempts < max_attempts
         ORDER BY next_touch_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
       ) RETURNING *`,
      [limit]
    );
    return r.rows;
  }
  const now = Date.now();
  const due = [...mem.values()]
    .filter((r) => r.status === 'queued' && !r.suppressed && r.next_touch_at.getTime() <= now && r.attempts < r.max_attempts)
    .sort((a, b) => a.next_touch_at - b.next_touch_at)
    .slice(0, limit);
  for (const r of due) { r.status = 'dialing'; r.attempts++; r.last_dispatched_at = new Date(); r.updated_at = new Date(); }
  return due;
}

async function recordOutcome(gcid, { status, outcome, nextTouchAt }) {
  if (USE_PG) {
    await pool.query(
      `UPDATE worklist SET status=$2, outcome=COALESCE($3,outcome),
         next_touch_at=COALESCE($4,next_touch_at), updated_at=now() WHERE gcid=$1`,
      [gcid, status, outcome || null, nextTouchAt || null]
    );
    return;
  }
  const r = mem.get(gcid);
  if (r) { r.status = status; if (outcome) r.outcome = outcome; if (nextTouchAt) r.next_touch_at = nextTouchAt; r.updated_at = new Date(); }
}

// Suppress by GCID or phone (opt-outs may only carry a phone number).
async function suppress({ gcid, phone }, reason) {
  const p = phone ? normalizePhone(phone) : null;
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE worklist SET suppressed=true, status='suppressed', outcome=$3, updated_at=now()
       WHERE gcid=$1 OR ($2 IS NOT NULL AND phone=$2) RETURNING gcid`,
      [gcid || null, p, reason || 'opted_out']
    );
    return r.rowCount > 0;
  }
  let hit = false;
  for (const r of mem.values()) {
    if ((gcid && r.gcid === gcid) || (p && r.phone === p)) { r.suppressed = true; r.status = 'suppressed'; r.outcome = reason || 'opted_out'; r.updated_at = new Date(); hit = true; }
  }
  return hit;
}

// Requeue contacts stuck in 'dialing' (claimed but no result reported) past a
// timeout — so an abandoned tab/worker doesn't strand them forever.
async function requeueStale(minutes = 10) {
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE worklist SET status='queued', updated_at=now()
       WHERE status='dialing' AND last_dispatched_at < now() - ($1 || ' minutes')::interval RETURNING gcid`,
      [String(minutes)]
    );
    return r.rowCount;
  }
  const cutoff = Date.now() - minutes * 60000; let n = 0;
  for (const r of mem.values()) {
    if (r.status === 'dialing' && r.last_dispatched_at && r.last_dispatched_at.getTime() < cutoff) { r.status = 'queued'; r.updated_at = new Date(); n++; }
  }
  return n;
}

// Look up a contact's GCID by phone (post-call webhook matching).
async function gcidForPhone(phone) {
  const p = normalizePhone(phone) || phone;
  if (!p) return null;
  if (USE_PG) {
    const r = await pool.query(`SELECT gcid FROM worklist WHERE phone=$1 ORDER BY updated_at DESC LIMIT 1`, [p]);
    return r.rows[0] ? r.rows[0].gcid : null;
  }
  for (const r of mem.values()) if (r.phone === p) return r.gcid;
  return null;
}

async function stats() {
  if (USE_PG) {
    const r = await pool.query(`SELECT status, count(*)::int AS n FROM worklist GROUP BY status`);
    const byStatus = {}; let total = 0;
    for (const row of r.rows) { byStatus[row.status] = row.n; total += row.n; }
    const sup = await pool.query(`SELECT count(*)::int AS n FROM worklist WHERE suppressed=true`);
    return { total, byStatus, suppressed: sup.rows[0].n };
  }
  const byStatus = {}; let suppressed = 0;
  for (const r of mem.values()) { byStatus[r.status] = (byStatus[r.status] || 0) + 1; if (r.suppressed) suppressed++; }
  return { total: mem.size, byStatus, suppressed };
}

module.exports = { init, normalizePhone, buildDeepLink, upsertLead, claimDue, recordOutcome, suppress, stats, gcidForPhone, requeueStale };
