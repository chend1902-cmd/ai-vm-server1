# Handoff — BDC Voice Agents (ElevenLabs)

Snapshot for whoever picks this up next (incl. a possible merge with another project).

## What this is
A BDC (Business Development Center) phone/text agent system for an auto dealership
(Mike Maroone Chevrolet WPB). The **agents run entirely on ElevenLabs Conversational
AI** (Eleven owns STT → LLM(Opus) → TTS → turn-taking). **This repo is a small
Node/Express server** that:
- serves per-call lead context to the agents,
- runs **outbound campaigns** (dial a worklist of leads), and
- hosts two operator UIs.

The old self-hosted realtime pipeline (Deepgram + Claude + Fish/Eleven TTS over Twilio
Media Streams) was deleted — it's in git history if ever needed.

## What's LIVE right now
- **Jake** (Sales Closer) is a real ElevenLabs agent and **works end to end**: the
  campaign dials customers **directly via ElevenLabs outbound** from **+15615565075**,
  Jake greets on answer, handles humans vs. voicemail.
- Agent id: `agent_7401ktjd33pcemevm8m9w87k6e91` · phone-number id:
  `phnum_8601ktmasypyeg8b3vbemcpmvxym` (both in `agents.json`).
- The other 4 agents are **spec'd but not yet created in Eleven** (their `agentId` is
  null in `agents.json`).

## The 5-agent stack (see `architecture.md` for the full map)
| Agent | Role | Channel | In Eleven? |
|---|---|---|---|
| **Riley** | Front desk / router | voice | no |
| **Jake** | Sales closer | voice + text | **yes (live)** |
| **Casey** | Speed-to-lead | **text/SMS only** | no |
| **Tara** | Trade-in & appraisal | voice + text | no |
| **Dana** | Follow-up / equity miner | text + voice | no |

Prompts for all five live in this README's sibling chat history and `agent-prompt.md`
(Jake's). Casey is text-only (no outbound voice dialing).

## UIs
- **`/campaign`** — operator console: upload the VinSolutions exports, pick agent + mode,
  run a paced block, mark outcomes. Secret-gated (`SHARED_SECRET`).
- **`/agents`** — agent dashboard: one widget per agent (placeholder avatar, one-line
  summary, and a "Start calls" control with a desired-call count). Text-only agents show
  no phone control. Widgets call `/campaign/start` for that agent.
- Secret for both: the `SHARED_SECRET` env value (stored in browser localStorage).

## How to run an outbound campaign
1. Export from VinSolutions: a **leads** report (with a **Cell Phone** column — required
   for direct dial) and the **CommunicationLog** report (for history).
2. `/campaign` → Lead type → drop both files → it joins on **Lead ID** (worklist = the
   leads, enriched with comms history).
3. Pick **Jake**, **Mode: `eleven_api`**, dry-run ON → Start → confirm, then dry-run OFF.
4. It dials each lead, paced, within calling hours. Mark outcomes as you go (or via the
   post-call webhook later).

## Key endpoints (`SHARED_SECRET`-gated)
- `POST /campaign/ingest` — load leads (CSV/JSON; flexible headers; phone normalized)
- `POST /campaign/start` `{agent, mode, dryRun, maxCalls, pacePerMinute}` · `/stop` · `GET /status`
- `GET /campaign/agents` — registry (label, summary, textOnly, apiReady)
- `GET /campaign/next` · `POST /campaign/result` · `POST /campaign/suppress`
- `POST /eleven/personalization` — Eleven conversation-init webhook (per-call context; off for outbound)
- `POST /eleven/postcall` — best-effort outcome + opt-out suppression

## HARD-WON GOTCHAS (read before debugging audio)
1. **Agent must be VOICE mode, not text-only.** A text-only agent generates the message
   (Eleven logs it "speaking") but emits **no audio** → dead silence both ways. This cost
   a multi-hour debug. Check this FIRST on any dead-air.
2. **Telephony audio format must be `ulaw_8000`** (μ-law 8 kHz) for both
   `conversation_config.tts.agent_output_audio_format` and `asr.user_input_audio_format`.
   The web default `pcm_16000` produces silence over Twilio.
3. **Voicemail handling** = Eleven's `voicemail_detection` built-in tool **+** a set
   `voicemail_message` **+** an **empty `first_message`** (so the agent listens first and
   detection can fire instead of greeting the machine).
4. **Direct dial needs a phone column** in the export. The first exports had none; the
   numbers embedded in comm *message text* are mostly the dealership's callback line — do
   NOT scrape those. Use the `Cell Phone` column.
5. If the Eleven number desyncs, **re-import it** (delete + create via the phone-numbers
   API, reassign the agent) — fixed a stuck integration.

## Where things live
- **Server code** → this repo (git) → auto-deploys to **Render** on push to `main`
  (`ai-vm-server1.onrender.com`).
- **Agent behavior** (prompts, first_message, audio format, voicemail, tools, number
  binding) → **ElevenLabs**, NOT git. Changes take effect immediately, but aren't backed up.
- **Agent registry** → `agents.json` (labels, IDs, summaries, textOnly, lead types).

## Open items / next steps
- Create Riley/Casey/Tara/Dana as real Eleven agents; put their `agentId` +
  `phoneNumberId` in `agents.json` → their dashboard widgets light up.
- Wire `transfer_to_agent` / `transfer_to_number` between agents (conditions drafted).
- Per-agent worklists (today all share one worklist + one dispatcher = **one campaign at
  a time**; the dashboard widgets start runs against that shared dispatcher).
- `DATABASE_URL` (Neon) for durable worklists across restarts (currently in-memory).
- Cox systems (vAuto/VinSolutions/Xtime) have no usable API → integration is browser
  scraping/automation (see `architecture.md`).
- The CRM no longer drives dialing (shim removed); customers are dialed direct and marked
  called manually afterward.
