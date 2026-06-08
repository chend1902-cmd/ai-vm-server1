// ElevenLabs streaming TTS over WebSocket (stream-input).
//
// Drop-in replacement for FishTTS — same EventEmitter interface so session.js
// can use either via the TTS_PROVIDER toggle. We keep ONE socket open for the
// whole call and stream each agent turn through it: pushText(...) then flush().
//
// Protocol (elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input):
//   client -> {text:' ', voice_settings, generation_config}  (BOS, first frame)
//   client -> {text:'...'}                 (one or many; each should end in a space)
//   client -> {text:' ', flush:true}       (force synthesis of buffered text)
//   client -> {text:''}                    (EOS: synth remaining, stream, then close)
//   server -> {audio:'<base64 pcm16le>', isFinal, normalizedAlignment}
//
// Emits 'audio' (Buffer of PCM16 LE at output_format sample rate), matching Fish.

const EventEmitter = require('events');
const WebSocket = require('ws');

class ElevenTTS extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY;
    this.voiceId = opts.voiceId || process.env.ELEVEN_VOICE_ID || null;
    // Flash is the low-latency model (~75ms TTFB) — right for a phone line.
    this.model = opts.model || process.env.ELEVEN_MODEL_ID || 'eleven_flash_v2_5';
    // pcm_8000 = raw 16-bit LE @ 8kHz, exactly what the pipeline already expects,
    // so no transcode/resample downstream. (pcm_8000 needs a paid tier.)
    this.sampleRate = opts.sampleRate || Number(process.env.ELEVEN_SAMPLE_RATE || 8000);
    // Voice character. Lower stability => more expressive but less consistent;
    // a steady professional phone voice wants mid stability + speaker boost.
    this.stability = Number(opts.stability ?? process.env.ELEVEN_STABILITY ?? 0.5);
    this.similarity = Number(opts.similarity ?? process.env.ELEVEN_SIMILARITY ?? 0.8);
    this.style = Number(opts.style ?? process.env.ELEVEN_STYLE ?? 0.0);
    this.speakerBoost = (process.env.ELEVEN_SPEAKER_BOOST ?? 'true') !== 'false';
    this.speed = Number(opts.speed ?? process.env.ELEVEN_SPEED ?? 1.0);
    // First chunk gates time-to-first-audio: smaller first value => faster start.
    this.chunkSchedule = opts.chunkSchedule || [120, 160, 250, 290];
    this.ready = false;
    this.closed = false;
    this._pending = []; // text queued before the socket is open
  }

  _sampleRateTag() {
    // ElevenLabs output_format names PCM by sample rate, e.g. pcm_8000.
    return `pcm_${this.sampleRate}`;
  }

  connect() {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
      `?model_id=${encodeURIComponent(this.model)}` +
      `&output_format=${this._sampleRateTag()}`;
    this.ws = new WebSocket(url, { headers: { 'xi-api-key': this.apiKey } });

    this.ws.on('open', () => {
      this.ws.send(
        JSON.stringify({
          text: ' ', // BOS frame
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarity,
            style: this.style,
            use_speaker_boost: this.speakerBoost,
            speed: this.speed,
          },
          generation_config: { chunk_length_schedule: this.chunkSchedule },
        })
      );
      this.ready = true;
      this._pending.forEach((t) => this._sendText(t));
      this._pending = [];
      this.emit('ready');
    });

    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.audio) {
        this.emit('audio', Buffer.from(msg.audio, 'base64'));
      }
      // isFinal marks the end of synthesis for the buffered/flushed text — the
      // same role as Fish's 'finish' (used to time the warm handoff / voicemail).
      if (msg.isFinal) this.emit('finish', 'final');
    });

    this.ws.on('error', (e) => this.emit('error', e));
    this.ws.on('close', () => {
      this.ready = false;
      this.emit('close');
    });
    return this;
  }

  _sendText(text) {
    if (this.closed || !text) return;
    // ElevenLabs buffers by token boundaries; a trailing space avoids gluing
    // chunks into one word across pushText calls.
    const t = text.endsWith(' ') ? text : text + ' ';
    this.ws.send(JSON.stringify({ text: t }));
  }

  // Stream a chunk of agent text (call repeatedly as Claude tokens arrive).
  pushText(text) {
    if (this.ready) this._sendText(text);
    else this._pending.push(text);
  }

  // Force synthesis of buffered text (end of a turn) without ending the stream,
  // so the same socket serves the next turn.
  flush() {
    if (this.ready) this.ws.send(JSON.stringify({ text: ' ', flush: true }));
  }

  // Signal end-of-stream: server synthesizes remaining text, streams it, emits a
  // final message, then closes. We don't tear down ourselves so we still receive
  // that last audio (used for the warm handoff).
  end() {
    this.closed = true;
    try {
      if (this.ready) this.ws.send(JSON.stringify({ text: '' }));
    } catch {}
  }

  close() {
    this.closed = true;
    try {
      if (this.ready) this.ws.send(JSON.stringify({ text: '' }));
    } catch {}
    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { ElevenTTS };
