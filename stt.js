// Deepgram streaming STT. We feed Twilio's mu-law 8 kHz frames straight in
// (encoding=mulaw, sample_rate=8000) and rely on Deepgram's endpointing +
// UtteranceEnd for turn detection, and SpeechStarted for barge-in.
//
// Emits:
//   'speechStarted'        -> customer began talking (trigger barge-in)
//   'transcript' (text, isFinal)
//   'utteranceEnd'         -> customer finished a turn (ask Claude to respond)

const EventEmitter = require('events');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

class DeepgramSTT extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.client = createClient(opts.apiKey || process.env.DEEPGRAM_API_KEY);
    this.model = opts.model || process.env.DEEPGRAM_MODEL || 'nova-2-phonecall';
    // Twilio sends mu-law 8k; the browser sim sends linear16 16k.
    this.encoding = opts.encoding || 'mulaw';
    this.sampleRate = opts.sampleRate || 8000;
    this.conn = null;
    this.ready = false;
  }

  start() {
    this.conn = this.client.listen.live({
      model: this.model,
      encoding: this.encoding,
      sample_rate: this.sampleRate,
      channels: 1,
      interim_results: true,
      smart_format: true,
      vad_events: true,
      endpointing: 300, // ms of silence -> speech_final
      utterance_end_ms: 1000,
    });

    this.conn.on(LiveTranscriptionEvents.Open, () => {
      this.ready = true;
      this.emit('open');
    });
    this.conn.on(LiveTranscriptionEvents.SpeechStarted, () => this.emit('speechStarted'));
    this.conn.on(LiveTranscriptionEvents.UtteranceEnd, () => this.emit('utteranceEnd'));
    this.conn.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
      const text = alt && alt.transcript;
      if (text) this.emit('transcript', text, !!data.is_final, !!data.speech_final);
    });
    this.conn.on(LiveTranscriptionEvents.Error, (e) => this.emit('error', e));
    this.conn.on(LiveTranscriptionEvents.Close, () => {
      this.ready = false;
      this.emit('close');
    });
    return this;
  }

  // Feed a raw mu-law frame (Buffer) from Twilio's customer leg.
  send(muLawBuffer) {
    if (this.ready && this.conn) this.conn.send(muLawBuffer);
  }

  close() {
    try {
      if (this.conn) this.conn.requestClose();
    } catch {}
  }
}

module.exports = { DeepgramSTT };
