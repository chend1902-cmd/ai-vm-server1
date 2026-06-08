// Fish Audio streaming TTS over WebSocket (MessagePack).
//
// Protocol (docs.fish.audio/api-reference/endpoint/websocket/tts-live):
//   client -> {event:'start', request:{text:'', format, sample_rate, reference_id, latency}}
//   client -> {event:'text', text:'...'}   (one or many)
//   client -> {event:'flush'}              (force synthesis of buffered text)
//   client -> {event:'stop'}               (end the session)
//   server -> {event:'audio', audio:<binary>}  (PCM when format=pcm)
//   server -> {event:'finish', reason}
//
// We keep ONE Fish connection open for the whole call and stream each agent turn
// through it: pushText(...) then flush(). Emits 'audio' (Buffer of PCM16 LE).

const EventEmitter = require('events');
const WebSocket = require('ws');
const { encode, decode } = require('@msgpack/msgpack');

const FISH_WS = 'wss://api.fish.audio/v1/tts/live';

class FishTTS extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.FISH_API_KEY;
    // Voice: opts.referenceId wins; else FISH_MODEL_ID; else null (Fish default
    // voice). Normalize '' -> null so a blanked env var means "use default".
    this.referenceId = opts.referenceId || process.env.FISH_MODEL_ID || null;
    this.model = opts.model || process.env.FISH_TTS_MODEL || 's2-pro';
    this.sampleRate = opts.sampleRate || Number(process.env.FISH_SAMPLE_RATE || 8000);
    // Latency knobs. 'balanced' synthesizes faster than 'normal'. Fish gates the
    // FIRST chunk on min_chunk_length (the real time-to-first-audio knob); the
    // hard floor for chunk_length is 100, so anything lower is clamped/ignored —
    // we keep chunk_length at the 100 floor and drive first-audio via min_chunk.
    this.latency = opts.latency || process.env.FISH_LATENCY || 'balanced';
    this.chunkLength = Number(opts.chunkLength || process.env.FISH_CHUNK_LENGTH || 100);
    this.minChunkLength = Number(opts.minChunkLength || process.env.FISH_MIN_CHUNK_LENGTH || 20);
    // Sampling: lower temperature => steadier, more consistent delivery (good for
    // a professional phone voice); higher => more expressive but less stable.
    this.temperature = Number(opts.temperature ?? process.env.FISH_TEMPERATURE ?? 0.6);
    this.topP = Number(opts.topP ?? process.env.FISH_TOP_P ?? 0.7);
    // Prosody: a touch of pace for BDC energy; normalize_loudness (s2-pro only)
    // keeps perceived volume even across emotional swings on a phone line.
    this.speed = Number(opts.speed ?? process.env.FISH_SPEED ?? 1.0);
    this.volume = Number(opts.volume ?? process.env.FISH_VOLUME ?? 0);
    this.normalizeLoudness = (process.env.FISH_NORMALIZE_LOUDNESS ?? 'true') !== 'false';
    this.ready = false;
    this.closed = false;
    this._pending = []; // text queued before the socket is open
  }

  connect() {
    this.ws = new WebSocket(FISH_WS, {
      headers: { Authorization: `Bearer ${this.apiKey}`, model: this.model },
    });

    this.ws.on('open', () => {
      this.ws.send(
        encode({
          event: 'start',
          request: {
            text: '',
            format: 'pcm',
            sample_rate: this.sampleRate,
            reference_id: this.referenceId,
            latency: this.latency,
            chunk_length: this.chunkLength,
            min_chunk_length: this.minChunkLength,
            temperature: this.temperature,
            top_p: this.topP,
            prosody: {
              speed: this.speed,
              volume: this.volume,
              normalize_loudness: this.normalizeLoudness,
            },
          },
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
        msg = decode(data);
      } catch {
        return;
      }
      if (msg.event === 'audio' && msg.audio) {
        this.emit('audio', Buffer.from(msg.audio));
      } else if (msg.event === 'finish') {
        this.emit('finish', msg.reason);
      } else if (msg.event === 'log') {
        // Fish occasionally sends log events; ignore.
      }
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
    this.ws.send(encode({ event: 'text', text }));
  }

  // Stream a chunk of agent text (call repeatedly as Claude tokens arrive).
  pushText(text) {
    if (this.ready) this._sendText(text);
    else this._pending.push(text);
  }

  // Force Fish to synthesize whatever text is buffered (end of a turn).
  flush() {
    if (this.ready) this.ws.send(encode({ event: 'flush' }));
  }

  // Signal end-of-stream: server synthesizes remaining text, streams the audio,
  // emits 'finish', then closes. Unlike close(), we don't tear down the socket
  // ourselves — so we still receive that final audio (used for the warm handoff).
  end() {
    this.closed = true;
    try {
      if (this.ready) this.ws.send(encode({ event: 'stop' }));
    } catch {}
  }

  close() {
    this.closed = true;
    try {
      if (this.ready) this.ws.send(encode({ event: 'stop' }));
    } catch {}
    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { FishTTS };
