# BDC AI Agent Architecture

ElevenLabs Conversational AI runs the agents (STT + LLM(Opus) + TTS + turn-taking).
This repo's server is the **integration hub**: it feeds per-call lead context to the
agents and brokers reads/writes to the dealership's Cox systems. Phone calls reach
the agents via Twilio (Eleven native integration + a VinSolutions press-1 shim at
`/twilio/vinsolutions`).

## The agent stack (5, concurrent, single-responsibility)

| # | Agent | Channel | Core purpose | Hard scope limit (transfers out) |
|---|---|---|---|---|
| 1 | **Riley** — Front Desk / Router | Voice (inbound) | Greet, detect intent, route fast | Never sells/quotes/books — routes only |
| 2 | **Jake** — Sales Closer | Voice + Text | Convert leads → booked showroom appointments | Service/price/trade → transfer |
| 3 | **Casey** — Speed-to-Lead | Text/SMS | Instant first-touch on new leads, qualify, hand off | Doesn't close/negotiate — passes to Jake |
| 4 | **Tara** — Trade-In & Appraisal | Voice + Text | Capture trade details, book the appraisal | Never quotes a value; buying → Jake |
| 5 | **Dana** — Follow-up / Equity Miner | Text + Voice (outbound) | Revive aged/no-show/be-back leads; mine owner base for upgrades | Re-engaged → hand to Jake |

**Principle:** each agent gets a lean prompt + scoped knowledge + least-privilege data
access. Out-of-lane requests `transfer_to_agent` / `transfer_to_number` — they don't
improvise. Topology is hub-and-spoke: Riley routes; Casey/Dana feed Jake; everyone
escalates to a human via `transfer_to_number`.

## Workflow & per-agent tools

Renders as a flow chart on GitHub / any Mermaid-aware markdown viewer. **Legend:**
`→agent` = transfer to another agent · `☎` = transfer to a human ·
`tool` = server tool to a data system · `KB` = knowledge base · `webhook` = personalization.

```mermaid
flowchart TD
    IN(["☎ Inbound call"]):::entry
    LEAD(["💬 New web lead"]):::entry
    WL(["📋 Outbound worklist<br/>(DB-backed)"]):::entry

    RILEY["<b>RILEY — Front Desk / Router</b> · voice<br/>———————<br/>→agent: Jake, Tara<br/>☎ human: Service, Manager<br/>system: end_call<br/>webhook: personalization<br/><i>no KB</i>"]:::agent
    CASEY["<b>CASEY — Speed-to-Lead</b> · text/SMS<br/>———————<br/>→agent: Jake, Tara<br/>tool: VinSolutions (log activity, W)<br/>webhook: personalization<br/><i>no KB</i>"]:::agent
    JAKE["<b>JAKE — Sales Closer ★</b> · voice+text<br/>———————<br/>→agent: Tara<br/>☎ human: Manager (warm handoff)<br/>tool: vAuto (availability, R)<br/>tool: VinSolutions (book appt+notes, W)<br/>KB: sales / CPO / financing<br/>webhook: personalization"]:::agent
    TARA["<b>TARA — Trade-In &amp; Appraisal</b> · voice+text<br/>———————<br/>→agent: Jake<br/>☎ human: Manager<br/>tool: vAuto (appraisal R/W — internal)<br/>tool: VinSolutions (book appraisal, W)<br/>KB: trade-in FAQ<br/>webhook: personalization"]:::agent
    DANA["<b>DANA — Follow-up / Equity</b> · text+voice, out<br/>———————<br/>→agent: Jake, Tara<br/>☎ human: Manager<br/>tool: DB (worklist/cadence/suppression)<br/>tool: Xtime (equity, R)<br/>tool: VinSolutions (history R, appt W)<br/>webhook: personalization · <i>no KB</i>"]:::agent

    APPT(["📅 Booked appointment"]):::done
    MGR(["☎ Manager / human"]):::human

    IN --> RILEY
    LEAD --> CASEY
    WL --> DANA

    RILEY -->|buying| JAKE
    RILEY -->|trade| TARA
    RILEY -->|service / other| MGR
    CASEY -->|warm lead| JAKE
    CASEY -->|trade question| TARA
    DANA -->|re-engaged| JAKE
    DANA -->|trade value| TARA
    JAKE <-->|buy / trade cross-refer| TARA
    JAKE --> APPT
    TARA --> APPT
    JAKE -.warm handoff.-> MGR
    TARA -.escalate.-> MGR
    DANA -.escalate.-> MGR

    classDef entry stroke:#2563eb,stroke-width:2px
    classDef agent stroke:#059669,stroke-width:2px
    classDef done stroke:#059669,stroke-width:3px
    classDef human stroke:#dc2626,stroke-width:2px
```

Note: tools beyond `end_call` / transfers are **gated on Cox scraping access** (see
below) — the agents work today on transfers + personalization; data tools light up as
each scraper lands.

## Two integration surfaces (per agent)

1. **Context-in (conversation start)** — ElevenLabs conversation-initiation
   (personalization) webhook → `/eleven/personalization` → returns the lead as
   `dynamic_variables` (`{{customer_name}}`, `{{vehicle}}`, `{{lead_context}}`).
   Enabled on all five agents (same URL).
2. **Actions (during conversation)** — ElevenLabs **server tools** → our server →
   the relevant data source.

## Systems & access (least privilege)

| Agent | VinSolutions (CRM spine) | vAuto | Xtime |
|---|---|---|---|
| **Riley** | R: caller lookup · W: log call/route | — | — |
| **Jake** | R: lead/history · W: appointment + notes | R: inventory availability (confirm only, never quote) | — |
| **Casey** | R: new lead · W: text activity | R: availability (light) | — |
| **Tara** | W: appraisal appt + notes | R/W: create appraisal, pull valuation (internal only — never spoken) | — |
| **Dana** | R: follow-up lists + history · W: activity + appt | R: current values for equity (optional) | R: service customers in an equity position |

- **VinSolutions is the spine** — every agent reads/writes it (system of record for
  leads, comms, appointments).
- **vAuto** = appraisals + inventory (Tara owns; Jake/Casey read-only).
- **Xtime** = equity-mining feed (Dana's source for who's mineable in the service drive).

## Integration reality: NO Cox API → Chrome-extension scraping + UI automation

Cox Automotive does not provide usable API access to vAuto / VinSolutions / Xtime, so
integration is done **through the browser**, extending the existing click-to-call
extension:

- **In-browser extension** (rep's logged-in session): scrapes the current Cox screen
  (e.g., the VinSolutions lead) and POSTs to the server — the existing `/arm` pattern —
  and can automate UI **writes** (fill/submit forms, click).
- **Background scraper** (a dedicated logged-in browser, e.g. Playwright/Puppeteer +
  the extension): periodically pulls **worklists** — Xtime equity candidates,
  VinSolutions follow-up lists — and pushes them to the server for the outbound agents
  (Dana, Casey).

### Read flow
```
Cox web UI → extension scrape → POST /arm (or /ingest) → server stores
          → served to the agent via personalization webhook (call start)
            or a server tool (mid-call)
```

### Write flow
```
agent calls a server tool ("book appraisal") → server queues the action
          → extension performs UI automation in the Cox tool (or a human confirms)
          → result logged back to VinSolutions
```

## Timing constraints (important)

- **Reads are easy when pre-armed:** the extension scrapes BEFORE the call (rep is on
  the lead's screen), so the personalization webhook already has the data.
- **Real-time writes during a live voice call are fragile** — UI automation is async vs
  a live conversation. Pattern: the agent captures the *intent*, and the write happens
  async via the extension (or the rep finalizes). Never promise the customer something
  that depends on a synchronous UI write landing mid-call.
- **Outbound agents (Dana, Casey)** need a persistent logged-in browser session feeding
  worklists — not the rep's ad-hoc tab.

## Risks of the scraping approach (eyes open)

- **Brittle:** DOM changes in Cox tools break scrapers — budget for maintenance.
- **Session-bound:** requires a logged-in browser; session expiry / 2FA can interrupt.
- **ToS:** scraping Cox tools may conflict with their terms — an operational/business
  risk to weigh (your dealership's own data, but the vendor ToS still applies).
- **Reliability:** build ingest idempotent and retry-tolerant; never let a failed scrape
  silently drop a lead. Log what was dropped.

## Anti-corruption principle

Least-privilege data access enforces agent scope at the **data layer**, not just the
prompt. An agent can't drift into another's lane because it doesn't have the keys/tools
for it. That's the strongest version of "don't let broad info corrupt the core purpose."

## Rollout order

1. **Agents + prompts** — works today on manually `/arm`-ed context. (Jake live ✅)
2. **In-browser scraping → personalization webhook** — extends the existing `/arm`.
3. **Per-agent server tools** as scrapers mature (Tara→vAuto, Dana→Xtime/VinSolutions).
4. **Background scraper** for outbound worklists (Dana/Casey).

## Call path (reference)

```
VinSolutions click-to-call → Twilio (+15615565075) → /twilio/vinsolutions
  → press "1" (ww1ww1ww1) → <Redirect> to Eleven native inbound → agent (Jake)
```
