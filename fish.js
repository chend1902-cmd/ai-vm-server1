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
    this.referenceId = opts.referenceId || process.env.FISH_MODEL_ID; // your cloned voice
    this.model = opts.model || process.env.FISH_TTS_MODEL || 's2-pro';
    this.sampleRate = opts.sampleRate || Number(process.env.FISH_SAMPLE_RATE || 8000);
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
            latency: 'normal',
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
