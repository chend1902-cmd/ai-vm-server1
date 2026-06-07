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
    `You are a friendly, professional appointment-setter calling a customer on behalf of a car dealership.
Your goal: have a natural phone conversation and book a time for them to come in (or confirm interest and a callback time).
Rules:
- Speak in SHORT, natural spoken sentences (one or two at a time). This is a live phone call, not an email.
- Never say you are an AI unless directly asked. Be warm and human.
- Listen and respond to what they actually say; do not monologue.
- If they're not interested, be gracious and offer to follow up later.
- Aim to confirm a concrete day/time before ending the call.`;

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
