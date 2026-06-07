// Caller-ID rotation across your Twilio numbers. One call at a time, but we
// rotate the "from" number each call for caller-ID variety / spam-label spread.

const pool = (process.env.TWILIO_NUMBERS || process.env.TWILIO_NUMBER || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let idx = 0;

function nextNumber() {
  if (pool.length === 0) {
    throw new Error('No Twilio numbers configured (set TWILIO_NUMBERS).');
  }
  const n = pool[idx % pool.length];
  idx++;
  return n;
}

module.exports = { nextNumber, pool };
