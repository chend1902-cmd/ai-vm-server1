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
const { BeepDetector } = require('./beep');

const MODE = { CONNECTING: 'connecting', ENGAGE: 'engage', VOICEMAIL: 'voicemail', TAKEN_OVER: 'taken_over', DONE: 'done' };

// Pull emotion/markup tags out of agent text for the call breakdown.
// s2-pro uses [bracket] tags (free-form); s1 uses (parenthesis) tags.
function extractEmotionTags(text) {
  if (!text) return [];
  const out = [];
  for (const re of [/\[[^\]\n]{1,40}\]/g, /\([^)\n]{1,40}\)/g]) {
    const m = text.match(re);
    if (m) out.push(...m);
  }
  return out;
}

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

    // Inbound (VinSolutions click-to-call) mode: VinSolutions dials the customer
    // and bridges us in, so there's no Twilio AMD — we detect voicemail by beep
    // and greet on the customer's first words.
    this.inbound = !!opts.inbound;
    this.beep = null;

    // Per-call structured log (timestamped events + emotion tags).
    this.startedAt = Date.now();
    this.transcript = [];
    this.customerNumber = opts.customerNumber || null;

    // Warm-takeover state. The agent says a handoff line, lets it finish playing,
    // then bridges in the manager — as if they stepped in to help.
    this.handingOff = false;
    this.handoffAudioDone = false;
    this.fromNumber = opts.from || null; // caller-ID to dial the manager from
    this.managerNumber = opts.managerNumber || process.env.MANAGER_NUMBER || process.env.REP_CELL || null;
    this.managerRingMs = Number(process.env.MANAGER_RING_TIMEOUT || 30000);
    this._managerDialed = false;
    const repName = opts.repName || process.env.REP_NAME || 'my sales manager';
    this.handoffLine =
      opts.handoffLine ||
      process.env.HANDOFF_LINE ||
      `${repName} just walked into my office, and ${repName} can take better care of you on this. Let me put ${repName} on real quick — one second.`;
  }

  setCallSids(customerCallSid, repCallSid) {
    this.customerCallSid = customerCallSid;
    this.repCallSid = repCallSid;
  }

  // Record one event in the call breakdown and echo it to the logs.
  _record(role, type, text = '') {
    const at = Date.now() - this.startedAt;
    const tags = extractEmotionTags(text);
    this.transcript.push({ at, role, type, text, tags });
    const tg = tags.length ? `  ⟨emotion: ${tags.join(' ')}⟩` : '';
    this.onLog(`[${(at / 1000).toFixed(1)}s] ${role}.${type}${text ? ': ' + text : ''}${tg}`);
  }

  // ---- Twilio media-stream plumbing ----
  attachLeg(role, ws, streamSid) {
    this.legs[role] = { ws, streamSid };
    this._record('system', role === 'rep' ? 'manager_connected' : 'customer_connected');
    if (!this.ticker) this._startTicker();
    // Inbound has no AMD — start the agent when the customer stream connects.
    if (this.inbound && role === 'customer' && this.mode === MODE.CONNECTING) this._beginInbound();
  }

  detachLeg(role) {
    if (this.legs[role]) this.legs[role] = null;
    if (role === 'customer') this.hangup('customer_stream_stopped');
    // If the manager hangs up after they've been bridged in, end the call.
    if (role === 'rep' && this.mode === MODE.TAKEN_OVER) this.hangup('rep_hung_up');
  }

  // Dial the manager on demand (warm transfer) and attach them as the rep leg.
  _dialManager() {
    if (this._managerDialed || this.legs.rep) return;
    if (!this.managerNumber || !this.twilioClient || !this.fromNumber) {
      this.onLog('cannot dial manager (missing number/from)');
      return;
    }
    this._managerDialed = true;
    const base = `https://${process.env.PUBLIC_HOST}`;
    this._record('system', 'dial_manager', this.managerNumber);
    this.twilioClient.calls
      .create({ to: this.managerNumber, from: this.fromNumber, url: `${base}/twilio/monitor?sid=${this.id}` })
      .then((c) => (this.repCallSid = c.sid))
      .catch((e) => this.onLog('manager dial error: ' + e.message));
  }

  onMedia(role, payloadB64) {
    const pcm = muLawB64ToPcm(payloadB64);
    if (role === 'customer') {
      // Inbound: until a human speaks, listen for a voicemail beep to branch.
      if (this.inbound && this.beep && !this.greeted && this.mode === MODE.ENGAGE) {
        if (this.beep.pushBase64(payloadB64)) this._inboundVoicemail();
      }
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

      // Warm handoff: bridge once the handoff line has played out AND the manager
      // has actually answered (their rep leg is connected).
      if (this.handingOff && this.handoffAudioDone && this.aiQueue.length === 0 && this.legs.rep) {
        this._completeTakeover();
      }
    }, 20);
  }

  // ---- Answering-machine detection result (from Twilio asyncAmd) ----
  onAmd(answeredBy) {
    if (this.mode !== MODE.CONNECTING) return;
    this._record('system', 'amd', String(answeredBy));
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
  // Inbound (Path A): start engaging but defer the greeting until the customer
  // speaks (or a fallback timer), and run beep detection for voicemail.
  _beginInbound() {
    this.beep = new BeepDetector();
    this._beginEngage({ deferGreet: true });
    this._greetTimer = setTimeout(() => {
      if (!this.greeted && this.mode === MODE.ENGAGE) {
        this.greeted = true;
        this._turn((onTok) => this.brain.greet(onTok));
      }
    }, Number(process.env.INBOUND_GREET_FALLBACK_MS || 6000));
  }

  _inboundVoicemail() {
    if (this.mode !== MODE.ENGAGE || this.greeted) return;
    this.greeted = true; // stop the greet path
    if (this._greetTimer) clearTimeout(this._greetTimer);
    if (this.stt) { this.stt.close(); this.stt = null; }
    this.brain = null;
    this._beginVoicemail(); // reuses this.fish if already connected
  }

  _beginEngage(opts = {}) {
    this.mode = MODE.ENGAGE;
    if (!this.fish) this._startFish();

    this.stt = new DeepgramSTT();
    this.stt.start();

    this.stt.on('speechStarted', () => {
      if (this.handingOff || this.mode === MODE.TAKEN_OVER) return; // don't interrupt the handoff
      // Barge-in: stop the agent the instant the customer talks over it.
      if (this.aiQueue.length > 0 || (this.brain && this.brain.stream)) {
        this.acceptingAi = false;
        this.aiQueue.clear();
        this._clear('customer');
        if (this.brain) this.brain.abort();
        this._record('system', 'barge_in');
      }
    });

    let buffer = '';
    const fire = () => {
      if (this.handingOff || this.mode === MODE.TAKEN_OVER) return; // agent is bowing out
      const said = buffer.trim();
      buffer = '';
      // Inbound: the customer's first words = a human answered -> greet, don't reply.
      if (this.inbound && !this.greeted) {
        this.greeted = true;
        if (this._greetTimer) clearTimeout(this._greetTimer);
        this.beep = null; // human confirmed; stop beep detection
        this._turn((onTok) => this.brain.greet(onTok));
        return;
      }
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

    // Open the conversation once Fish is ready (outbound greets immediately;
    // inbound defers until the customer speaks — see fire()).
    const openGreeting = () => {
      if (this.greeted) return;
      this.greeted = true;
      this._turn((onTok) => this.brain.greet(onTok));
    };
    if (!opts.deferGreet) {
      if (this.fish.ready) openGreeting();
      else this.fish.once('ready', openGreeting);
    }
  }

  _respond(customerText) {
    this._record('customer', 'said', customerText);
    this._turn((onTok) => this.brain.respond(customerText, onTok));
  }

  // Run one agent turn: stream Claude tokens -> Fish, sentence by sentence.
  async _turn(producer) {
    this.acceptingAi = true;
    let pending = '';
    let handoff = false;
    let spoke = false;
    // Each chunk is pushed AND flushed, so Fish synthesizes it immediately
    // instead of buffering until end-of-reply.
    const speakChunk = (t) => {
      const seg = t.trim();
      if (!seg) return;
      this._speak(seg);
      if (this.fish) this.fish.flush();
      spoke = true;
    };
    const flushChunk = (force) => {
      if (handoff) return;
      // Never speak the [[HANDOFF]] control token. But single-bracket emotion
      // tags ([warm], [confident], ...) are meant FOR Fish and must pass straight
      // through — so only hold when a DOUBLE bracket (or a lone trailing '[' that
      // could still become one) is forming.
      if (/\[\[/.test(pending) || /\[\s*$/.test(pending)) {
        if (!force) return;
        if (/\[\[\s*HANDOFF/i.test(pending)) return; // confirmed handoff; don't speak it
      }
      // Drain complete clauses first (so the opening goes out as soon as possible).
      let m;
      while ((m = pending.match(/^([\s\S]*?[.!?,;:])\s+/))) {
        speakChunk(m[1]);
        pending = pending.slice(m[0].length);
      }
      // Nothing spoken yet but enough words to start — fire the opening group now
      // (the single biggest perceived-latency win: agent starts talking sooner).
      if (!spoke && !force && pending.length >= 10) {
        const i = pending.lastIndexOf(' ');
        if (i > 0) {
          speakChunk(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
      }
      if (force && pending.trim()) {
        speakChunk(pending);
        pending = '';
      }
    };
    const text = await producer((tok) => {
      pending += tok;
      if (/\[\[\s*HANDOFF/i.test(pending)) handoff = true;
      flushChunk(false);
    });
    // Agent decided it can't help -> run the warm handoff instead of speaking.
    if (handoff || /\[\[\s*HANDOFF/i.test(text || '')) {
      this._record('agent', 'handoff_signal', '[[HANDOFF]]');
      this.takeOver();
      return;
    }
    flushChunk(true);
    this._endSpeak();
    if (text) this._record('agent', 'said', text);
  }

  // ---- Voicemail branch (machine answered) ----
  _beginVoicemail() {
    this.mode = MODE.VOICEMAIL;
    if (!this.fish) this._startFish();
    const msg = this.script || 'Hi, just following up with you. Give us a call back when you get a chance. Thanks!';
    const leave = () => {
      this.acceptingAi = true;
      this._record('agent', 'voicemail', msg);
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

  // ---- Warm Take Over (dial-on-handoff / warm transfer) ----
  // The agent says a natural handoff line, and IN PARALLEL we dial the manager.
  // Once the line has played AND the manager has answered, we bridge them to the
  // customer and drop the AI. If a manager leg is already present (monitor mode),
  // we just bridge that one.
  takeOver() {
    if (this.mode === MODE.TAKEN_OVER || this.mode === MODE.DONE) return false;
    if (this.handingOff) return true; // already in progress
    if (this.mode !== MODE.ENGAGE || !this.fish) {
      // Not in a live conversation — bridge directly if a manager is already on.
      if (this.legs.rep) return this._completeTakeover();
      this._dialManager();
      return true;
    }
    this._record('system', 'warm_takeover');
    this.handingOff = true;
    this.handoffAudioDone = false;

    // Cut any in-progress agent turn so the handoff line plays cleanly.
    if (this.brain) this.brain.abort();
    this.acceptingAi = false;
    this.aiQueue.clear();
    this._clear('customer');

    // Dial the manager now (parallel with the line) unless one's already connected.
    if (!this.legs.rep) this._dialManager();

    // Speak the handoff line; mark when all its audio has arrived. The ticker
    // bridges once that audio is done AND the manager's leg is connected.
    this.acceptingAi = true;
    this.fish.once('finish', () => {
      this.handoffAudioDone = true;
    });
    this.fish.pushText(this.handoffLine);
    this.fish.flush();
    this.fish.end(); // tells Fish no more text -> it sends the audio then 'finish'

    // Safety net: mark audio done even if 'finish' never lands.
    this._audioTimer = setTimeout(() => {
      this.handoffAudioDone = true;
    }, 12000);

    // No-answer fallback: if the manager never picks up, don't leave the customer
    // hanging — end the call. (A spoken "I'll have them call you back" can come later.)
    this._handoffTimer = setTimeout(() => {
      if (this.mode !== MODE.TAKEN_OVER && this.mode !== MODE.DONE) {
        this.onLog('manager did not answer — ending call');
        this.hangup('handoff_no_answer');
      }
    }, this.managerRingMs);
    return true;
  }

  _completeTakeover() {
    if (this.mode === MODE.TAKEN_OVER || this.mode === MODE.DONE) return false;
    this._record('system', 'bridged');
    this.mode = MODE.TAKEN_OVER;
    this.handingOff = false;
    this.acceptingAi = false;
    this.aiQueue.clear();
    if (this._handoffTimer) clearTimeout(this._handoffTimer);
    if (this._audioTimer) clearTimeout(this._audioTimer);
    if (this.stt) this.stt.close();
    if (this.fish) this.fish.close();
    this.stt = null;
    this.fish = null;
    this.brain = null;
    return true; // ticker now bridges rep <-> customer
  }

  hangup(reason) {
    if (this.mode === MODE.DONE) return;
    this._record('system', 'hangup', reason || '');
    this.mode = MODE.DONE;
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
