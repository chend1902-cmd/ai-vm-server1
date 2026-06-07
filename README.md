# AI Voice Agent — Realtime, Fish Audio, with Live Monitor + Take-Over

Replaces the old voicemail-only / ElevenLabs setup with a **self-hosted realtime
voice agent** so you own the entire media path (and monitoring can't be blocked).

When the extension fires `/start-call`:

- **Human answers** → Deepgram (STT) → Claude (brain) → **Fish Audio** (voice) hold
  a live conversation, with barge-in.
- **Voicemail answers** → Fish leaves your message after the greeting, then hangs up.
- **Either way** → your cell rings and joins to **listen live**; hit **Take Over**
  to drop the AI and talk to the customer yourself.

## Architecture

```
Extension (dialer3) ── POST /start-call ──► Render server (this repo)
                                              │  REST: /start-call /take-over /hangup /amd
                                              │  TwiML: /twilio/outbound /twilio/monitor
                                              │  WS:   /media  (Twilio Media Streams, mu-law 8k)
   Customer leg  <Connect><Stream> ◄──────────┤
   Your-cell leg <Connect><Stream> ◄──────────┘
        Deepgram (ears) · Claude (brain) · Fish (voice) — all in-process
```

Modules: `index.js` (server) · `session.js` (per-call state machine + 20 ms audio
bridge) · `audio.js` (mu-law ⇄ PCM, resample, mixing) · `fish.js` · `stt.js` ·
`brain.js` · `numbers.js` (caller-ID rotation) · `beep.js` (fallback beep detector).

## Setup

1. **Env** — copy `.env.example` to `.env` and fill in Twilio, Fish, Deepgram,
   Anthropic, your 4 `TWILIO_NUMBERS`, and `REP_CELL`. Set `SHARED_SECRET`.
2. **Deploy to Render** (needs a long-lived WebSocket — not Vercel). New → Web
   Service → this repo. Build `npm install`, start `npm start`, **always-on**
   instance. Set `PUBLIC_HOST` to the assigned `*.onrender.com` host (no scheme)
   and add all env vars.
3. **Extension** — in `dialer3/background.js` set `SERVER_URL` to your Render URL
   and `SHARED_SECRET` to match. Load `dialer3/` as an unpacked extension.
4. You do **not** point a Twilio number's webhook here — calls are placed
   outbound by `/start-call`, which sets the per-call TwiML URLs itself.

## Test

1. **Smoke** — visit `https://<host>/` → "AI voice-agent server up".
2. **Softphone (no real customer)** — `/start-call` with your softphone web app as
   the customer number. Speak → confirm transcript → Claude reply → Fish voice,
   acceptable latency.
3. **Voicemail** — call a real cell, let it ring to voicemail. AMD fires
   `machine_end_beep`; Fish plays the script; call ends; row logged (if Neon set).
4. **Human + monitor + takeover** — answer as a human; your cell rings and joins
   muted; you hear customer + AI; **Take Over** bridges you to the customer live.
5. **Rotation** — place several calls; confirm `from` cycles the 4 numbers.

## Tuning

- Turn-taking: `endpointing` / `utterance_end_ms` in `stt.js`.
- Latency vs richness: `LLM_MODEL` (Haiku 4.5 ↔ Sonnet 4.6) in `.env`.
- AMD: uses `DetectMessageEnd` (waits for greeting to finish). `beep.js` remains
  as a fallback beep trigger if you want to wire it in.
- Persona/script: `brain.js` `buildSystemPrompt` + the extension's voicemail box.
