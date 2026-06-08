# BDC Voice Agent — ElevenLabs Conversational AI + lead-context webhook

The voice agent runs on **ElevenLabs Conversational AI**: ElevenLabs owns the
whole speech pipeline (STT → LLM → TTS → turn-taking/barge-in) and connects to
Twilio via its **native integration**. The LLM is configured inside the Eleven
agent (Opus) with the system prompt from [`agent-prompt.md`](./agent-prompt.md).

This repo is just a small **lead-context webhook**: it holds the lead data for the
next call and hands it to the Eleven agent so it can greet with the specific
vehicle/customer.

> Earlier this repo was a self-hosted realtime pipeline (Deepgram + Claude + Fish
> over Twilio Media Streams, with live monitor + take-over). That moved into
> ElevenLabs to fix latency/quality. The old code is in git history if needed.

## Architecture

```
Browser extension ── POST /arm ──► this server (Render)         stores "armed" lead
                                                                       │
VinSolutions click-to-call ──► Twilio number ──► ElevenLabs agent (native integration)
                                                       │  STT + LLM(Opus) + TTS + turns
   ElevenLabs ── POST /eleven/personalization ─────────┘  (conversation-initiation webhook)
   ◄── { dynamic_variables: { lead_context, customer_name, vehicle } }
        → fills {{placeholders}} in the agent's prompt / first message
```

Files: `index.js` (the webhook server) · `agent-prompt.md` (the agent's system
prompt, source of truth) · `.env.example`.

## Setup

1. **ElevenLabs agent** — create a Conversational AI agent; set the LLM (Opus),
   voice, and paste `agent-prompt.md` into the System Prompt (keep the
   `{{lead_context}}` / `{{customer_name}}` / `{{vehicle}}` placeholders).
2. **Connect Twilio** — Eleven → Agents → Phone Numbers → import your Twilio
   number (native integration; enter Twilio SID + Auth Token) and assign the
   agent. Eleven auto-configures the number's webhook. VinSolutions dials that
   number; the call lands on the agent.
3. **This server** — `npm install`, deploy to Render. Set `SHARED_SECRET` (and
   optionally `WEBHOOK_SECRET`). Start `npm start`.
4. **Personalization webhook** — in the Eleven agent's security/advanced
   settings, set the conversation-initiation ("fetch conversation initiation
   data") webhook to `https://<host>/eleven/personalization`.
5. **Extension** — keep it POSTing the lead to `/arm` (with `SHARED_SECRET`).

## Endpoints

- `POST /arm` — `{ secret, customerName?, vehicle?, screenText?/leadContext? }`. Arms the next call.
- `POST /eleven/personalization` — Eleven's conversation-initiation webhook; returns the armed lead as `dynamic_variables`. Logs the raw request so you can confirm Eleven's exact fields on the first real call.

## Rebuilding bespoke features on Eleven

Features from the old pipeline map to Eleven primitives: warm handoff → a
"transfer to number" tool; call logs → a post-call webhook; per-lead context →
this webhook. Live "listen-in" monitoring has no clean native equivalent and
would need a Twilio-side bridge.
