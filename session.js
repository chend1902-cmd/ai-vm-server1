// Per-call state machine + audio bridge. One active Session at a time.
//
// Two Twilio legs stream bidirectionally into our /media socket:
//   - customer leg  (the lead)
//   - rep/monitor leg (your cell, joined muted)
//
// A single 20 ms ticker owns all outbound audio so everything stays real-time:
//   - AI (Fish PCM) -> customer        (when engaging or leaving voicemail)
//   - mix(AI, customer) -> rep         (live monitor)
//   - on Take Over: rep <-> customer   (full duplex; AI dropped)
//
// Because every frame flows through this process, monitoring can never be gated
// by a third party — the whole reason we left ElevenLabs.

const {
  FRAME_SAMPLES,
  muLawB64ToPcm,
  pcmToMuLawB64,
  pcmBufferToInt16LE,
  resampleInt16,
  mixSample,
  SampleQueue,
} = require('./audio');
const { FishTTS } = require('./fish');
const { DeepgramSTT } = require('./stt');
const { Brain } = require('./brain');

const MODE = { CONNECTING: 'connecting', ENGAGE: 'engage', VOICEMAIL: 'voicemail', TAKEN_OVER: 'taken_over', DONE: 'done' };

class Session {
  constructor(opts) {
    this.id = opts.id;
    this.script = opts.script || '';
    this.leadContext = opts.leadContext || '';
    this.persona = opts.persona || '';
    this.twilioClient = opts.twilioClient;
    this.onLog = opts.onLog || (() => {});

    this.customerCallSid = null;
    this.repCallSid = null;

    // Twilio media-stream sockets + streamSids, keyed by leg role.
    this.legs = { customer: null, rep: null }; // { ws, streamSid }

    this.mode = MODE.CONNECTING;
    this.fishSampleRate = Number(process.env.FISH_SAMPLE_RATE || 8000);

    // Audio queues feeding the ticker.
    this.aiQueue = new SampleQueue(); // AI voice -> customer
    this.custQueue = new SampleQueue(); // customer audio -> rep mix / -> rep on takeover
    this.repQueue = new SampleQueue(); // rep audio -> customer on takeover

    this.acceptingAi = false; // false during barge-in so late Fish audio is dropped
    this.ticker = null;
    this.greeted = false;
  }

  setCallSids(customerCallSid, repCallSid) {
    this.customerCallSid = customerCallSid;
    this.repCallSid = repCallSid;
  }

  // ---- Twilio media-stream plumbing ----
  attachLeg(role, ws, streamSid) {
    this.legs[role] = { ws, streamSid };
    this.onLog(`leg attached: ${role}`);
    if (!this.ticker) this._startTicker();
  }

  detachLeg(role) {
    if (this.legs[role]) this.legs[role] = null;
    if (role === 'customer') this.hangup('customer_stream_stopped');
  }

  onMedia(role, payloadB64) {
    const pcm = muLawB64ToPcm(payloadB64);
    if (role === 'customer') {
      // Feed STT (raw mu-law) when engaging; buffer PCM for the monitor mix.
      if (this.stt) this.stt.send(Buffer.from(payloadB64, 'base64'));
      this.custQueue.push(pcm);
    } else if (role === 'rep') {
      this.repQueue.push(pcm); // only used after Take Over
    }
  }

  _send(role, b64) {
    const leg = this.legs[role];
    if (!leg || !leg.ws || leg.ws.readyState !== 1) return;
    leg.ws.send(JSON.stringify({ event: 'media', streamSid: leg.streamSid, media: { payload: b64 } }));
  }

  _clear(role) {
    const leg = this.legs[role];
    if (!leg || !leg.ws || leg.ws.readyState !== 1) return;
    leg.ws.send(JSON.stringify({ event: 'clear', streamSid: leg.streamSid }));
  }

  // The single real-time clock. Every 20 ms it emits exactly one frame per active
  // direction, pulling from the queues. This is what keeps audio from garbling.
  _startTicker() {
    this.ticker = setInterval(() => {
      const cust = this.custQueue.read(FRAME_SAMPLES); // customer's live audio
      const rep = this.repQueue.read(FRAME_SAMPLES); // rep's live audio

      if (this.mode === MODE.TAKEN_OVER) {
        // Full-duplex human bridge: rep <-> customer.
        if (rep.filled) this._send('customer', pcmToMuLawB64(rep.samples));
        if (cust.filled) this._send('rep', pcmToMuLawB64(cust.samples));
        return;
      }

      // Engage / voicemail: AI talks to the customer.
      const ai = this.aiQueue.read(FRAME_SAMPLES);
      if (ai.filled) this._send('customer', pcmToMuLawB64(ai.samples));

      // Monitor: rep hears AI + customer mixed (only while a rep leg is attached).
      if (this.legs.rep) {
        const mixed = new Int16Array(FRAME_SAMPLES);
        for (let i = 0; i < FRAME_SAMPLES; i++) mixed[i] = mixSample(ai.samples[i], cust.samples[i]);
        this._send('rep', pcmToMuLawB64(mixed));
      }
    }, 20);
  }

  // ---- Answering-machine detection result (from Twilio asyncAmd) ----
  onAmd(answeredBy) {
    if (this.mode !== MODE.CONNECTING) return;
    this.onLog(`AMD: ${answeredBy}`);
    if (answeredBy === 'human' || answeredBy === 'unknown') {
      this._beginEngage();
    } else if (String(answeredBy).startsWith('machine')) {
      this._beginVoicemail();
    } else {
      // fax / other -> just leave the voicemail script as a fallback.
      this._beginVoicemail();
    }
  }

  _startFish() {
    this.fish = new FishTTS();
    this.fish.on('audio', (pcmBuf) => {
      if (!this.acceptingAi) return; // dropped after barge-in
      let pcm = pcmBufferToInt16LE(pcmBuf);
      if (this.fishSampleRate !== 8000) pcm = resampleInt16(pcm, this.fishSampleRate, 8000);
      this.aiQueue.push(pcm);
    });
    this.fish.on('error', (e) => this.onLog('fish error: ' + e.message));
    this.fish.connect();
  }

  _speak(text) {
    this.acceptingAi = true;
    this.fish.pushText(text);
  }

  _endSpeak() {
    if (this.fish) this.fish.flush();
  }

  // ---- Live conversation (human answered) ----
  _beginEngage() {
    this.mode = MODE.ENGAGE;
    this._startFish();

    this.stt = new DeepgramSTT();
    this.stt.start();

    this.stt.on('speechStarted', () => {
      // Barge-in: stop the agent the instant the customer talks over it.
      if (this.aiQueue.length > 0 || (this.brain && this.brain.stream)) {
        this.acceptingAi = false;
        this.aiQueue.clear();
        this._clear('customer');
        if (this.brain) this.brain.abort();
      }
    });

    let buffer = '';
    const fire = () => {
      const said = buffer.trim();
      buffer = '';
      if (said) this._respond(said);
    };
    this.stt.on('transcript', (text, isFinal, speechFinal) => {
      if (isFinal && text) buffer += (buffer ? ' ' : '') + text;
      // Respond as soon as Deepgram marks end-of-speech (~300ms via endpointing),
      // instead of waiting for the 1000ms UtteranceEnd timer. Big latency win.
      if (speechFinal) fire();
    });
    // Fallback: if speech_final never fired but the utterance ended, respond.
    this.stt.on('utteranceEnd', () => fire());

    this.brain = new Brain({ persona: this.persona, script: this.script, leadContext: this.leadContext });

    // Open the conversation once Fish is ready.
    const openGreeting = () => {
      if (this.greeted) return;
      this.greeted = true;
      this._turn((onTok) => this.brain.greet(onTok));
    };
    if (this.fish.ready) openGreeting();
    else this.fish.once('ready', openGreeting);
  }

  _respond(customerText) {
    this.onLog('customer: ' + customerText);
    this._turn((onTok) => this.brain.respond(customerText, onTok));
  }

  // Run one agent turn: stream Claude tokens -> Fish, sentence by sentence.
  async _turn(producer) {
    this.acceptingAi = true;
    let pending = '';
    const flushChunk = (force) => {
      // Send on sentence boundaries for low latency without choppy synthesis.
      const m = pending.match(/^(.*[.!?,;:])\s+/);
      if (m) {
        this._speak(m[1]);
        pending = pending.slice(m[0].length);
      } else if (force && pending.trim()) {
        this._speak(pending.trim());
        pending = '';
      }
    };
    const text = await producer((tok) => {
      pending += tok;
      flushChunk(false);
    });
    flushChunk(true);
    this._endSpeak();
    if (text) this.onLog('agent: ' + text);
  }

  // ---- Voicemail branch (machine answered) ----
  _beginVoicemail() {
    this.mode = MODE.VOICEMAIL;
    this._startFish();
    const msg = this.script || 'Hi, just following up with you. Give us a call back when you get a chance. Thanks!';
    const leave = () => {
      this.acceptingAi = true;
      this.fish.pushText(msg);
      this.fish.flush();
      // Hang up after the message has had time to play out.
      this.fish.once('finish', () => setTimeout(() => this.hangup('voicemail_left'), 1500));
      // Safety net if 'finish' never arrives.
      setTimeout(() => this.hangup('voicemail_left'), 45000);
    };
    if (this.fish.ready) leave();
    else this.fish.once('ready', leave);
  }

  // ---- Take Over (you barge in from your cell) ----
  takeOver() {
    if (this.mode === MODE.TAKEN_OVER || this.mode === MODE.DONE) return false;
    this.onLog('TAKE OVER');
    this.mode = MODE.TAKEN_OVER;
    this.acceptingAi = false;
    this.aiQueue.clear();
    this._clear('customer');
    if (this.brain) this.brain.abort();
    if (this.stt) this.stt.close();
    if (this.fish) this.fish.close();
    this.stt = null;
    this.fish = null;
    this.brain = null;
    return true; // ticker now bridges rep <-> customer
  }

  hangup(reason) {
    if (this.mode === MODE.DONE) return;
    this.mode = MODE.DONE;
    this.onLog('hangup: ' + (reason || ''));
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (this.stt) this.stt.close();
    if (this.fish) this.fish.close();
    // End both Twilio call legs.
    for (const sid of [this.customerCallSid, this.repCallSid]) {
      if (sid && this.twilioClient) {
        this.twilioClient.calls(sid).update({ status: 'completed' }).catch(() => {});
      }
    }
    if (this.onDone) this.onDone(reason);
  }
}

module.exports = { Session, MODE };
