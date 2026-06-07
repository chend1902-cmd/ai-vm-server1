// Audio helpers for Twilio Media Streams (8 kHz mu-law / G.711u).
//
// Twilio sends/receives 8 kHz mu-law in 20 ms frames (160 bytes). Deepgram takes
// that mu-law directly. Fish Audio streams back PCM16 (we request 8 kHz), which we
// convert to mu-law before handing to Twilio. This module owns all of that.

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const BIAS = 0x84;
const CLIP = 32635;

// ---- mu-law decode (G.711 u-law byte -> signed 16-bit PCM) ----
function muLawDecode(u) {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? BIAS - t : t - BIAS;
}

// ---- mu-law encode (signed 16-bit PCM -> G.711 u-law byte) ----
function muLawEncode(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Decode a base64 mu-law payload (one Twilio media frame) -> Int16Array PCM.
function muLawB64ToPcm(b64) {
  const bytes = Buffer.from(b64, 'base64');
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = muLawDecode(bytes[i]);
  return out;
}

// Encode an Int16Array of PCM -> base64 mu-law (for a Twilio media payload).
function pcmToMuLawB64(samples) {
  const bytes = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) bytes[i] = muLawEncode(samples[i]);
  return bytes.toString('base64');
}

// Fish PCM arrives as a Buffer of signed 16-bit little-endian samples.
function pcmBufferToInt16LE(buf) {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

// Linear resample Int16 PCM from inRate to outRate. Identity when equal
// (we ask Fish for 8 kHz, but keep this as a safety net for other rates).
function resampleInt16(samples, inRate, outRate) {
  if (inRate === outRate) return samples;
  const ratio = inRate / outRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = (samples[i0] * (1 - frac) + samples[i1] * frac) | 0;
  }
  return out;
}

// Sum two PCM samples with clipping (for mixing customer + AI on the monitor leg).
function mixSample(a, b) {
  let s = a + b;
  if (s > 32767) s = 32767;
  else if (s < -32768) s = -32768;
  return s;
}

// A FIFO of PCM samples backed by Int16Array chunks. read(n) always returns
// n samples (zero-padded), plus how many were real — so the 20 ms ticker never
// stalls and we can tell silence from audio.
class SampleQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }
  push(samples) {
    if (!samples || samples.length === 0) return;
    this.chunks.push(samples);
    this.length += samples.length;
  }
  read(n) {
    const out = new Int16Array(n);
    let filled = 0;
    while (filled < n && this.chunks.length) {
      const chunk = this.chunks[0];
      const avail = chunk.length - this.offset;
      const take = Math.min(avail, n - filled);
      out.set(chunk.subarray(this.offset, this.offset + take), filled);
      filled += take;
      this.offset += take;
      this.length -= take;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return { samples: out, filled };
  }
  clear() {
    this.chunks = [];
    this.offset = 0;
    this.length = 0;
  }
}

module.exports = {
  SAMPLE_RATE,
  FRAME_SAMPLES,
  muLawDecode,
  muLawEncode,
  muLawB64ToPcm,
  pcmToMuLawB64,
  pcmBufferToInt16LE,
  resampleInt16,
  mixSample,
  SampleQueue,
};
