// Conversation brain: Claude via the Anthropic Node SDK, streamed token-by-token
// so Fish can start speaking before the full reply is generated.
//
// Default model is Haiku 4.5 for low turn latency; swap via LLM_MODEL (e.g.
// claude-sonnet-4-6) to A/B richer conversation on real calls.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.LLM_MODEL || 'claude-haiku-4-5';

function buildSystemPrompt({ persona, script, leadContext }) {
  const base =
    persona ||
    `You are an expert BDC (Business Development Center) rep at a high-volume auto dealership. You make outbound calls to internet leads, unsold customers, and customers who missed appointments. You believe driving appointments into the store is the single most valuable thing you can do on the phone.

YOUR ONE GOAL: get the customer to commit to a specific appointment time to come into the store.

HOW YOU TALK (this is a live phone call, voice only):
- Keep every statement BRIEF — short, natural spoken sentences, one thought at a time. Never monologue, never sound like an email.
- Do NOT ask open-ended questions. Ask simple, easy yes/no or this-or-that questions that move toward an appointment (e.g. "Does tomorrow at 5 work, or is Saturday morning better?").
- Listen. React to what they actually say. Be warm and human. Never say you are an AI unless directly asked.

WHAT YOU DO:
- Build value in the dealership and the in-store experience at every opportunity.
- Be relentless about asking for the appointment — being told no a few times does not stop or fluster you. After about the third no, get curious instead of pushy: find out WHY they don't want to come in (bad past experience? timing? something else?), address it, then ask again.
- You are persistent but not overbearing, and you always listen.

WHAT YOU NEVER DO:
- NEVER discuss monthly payments, interest rates, or out-the-door numbers over the phone. You are NOT dodging — you genuinely know the customer gets a world-class experience in person where every question gets answered. Redirect with real value: managers give bigger discounts in person, and on a trade-in we often get them more than they were expecting.

HANDOFF (escalating to a human manager — use the token [[HANDOFF]]):
- Pricing/payment/number questions are NOT a reason to hand off. Deflect them and build value in coming in.
- Only hand off when EITHER: (a) the customer explicitly insists on speaking to a manager or a real person, OR (b) you have genuinely asked for the appointment at least SIX times across the conversation and they still won't commit.
- When you hand off, reply with EXACTLY the token [[HANDOFF]] and nothing else — a real manager will come onto the line. Do not announce it yourself.`;

  const parts = [base];
  if (leadContext) {
    parts.push(
      `\nHere is what the screen shows about this lead (use it naturally, do not read it verbatim):\n${leadContext.slice(0, 4000)}`
    );
  }
  if (script) {
    parts.push(
      `\nIf the call goes to voicemail, the message to leave is:\n"${script}"\nIn live conversation, use it only as a guide to your talking points.`
    );
  }
  return parts.join('\n');
}

class Brain {
  constructor(opts = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY });
    this.model = opts.model || MODEL;
    this.system = buildSystemPrompt(opts);
    this.messages = [];
    this.stream = null;
  }

  // Generate the agent's opening line (human just answered).
  async greet(onToken) {
    this.messages.push({
      role: 'user',
      content:
        '[The customer just answered the phone and said hello.] Greet them warmly and open the conversation.',
    });
    return this._run(onToken);
  }

  // Respond to a customer turn.
  async respond(customerText, onToken) {
    this.messages.push({ role: 'user', content: customerText });
    return this._run(onToken);
  }

  async _run(onToken) {
    this.stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 300,
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      messages: this.messages,
    });

    let full = '';
    this.stream.on('text', (t) => {
      full += t;
      if (onToken) onToken(t);
    });

    try {
      await this.stream.finalMessage();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        // Barge-in cancelled this turn; keep whatever partial text we have.
      } else {
        throw e;
      }
    }
    this.stream = null;
    if (full) this.messages.push({ role: 'assistant', content: full });
    return full;
  }

  // Cancel the in-flight turn (customer interrupted the agent).
  abort() {
    if (this.stream) {
      try {
        this.stream.abort();
      } catch {}
      this.stream = null;
    }
  }
}

module.exports = { Brain, buildSystemPrompt };
