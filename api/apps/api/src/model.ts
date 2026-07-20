// ModelServingDriver — the seam every "AI" capability sits behind, so the product
// runs in all three shapes (pooled SaaS, dedicated, air-gapped) without a hardcoded
// vendor. The DEFAULT is a deterministic, dependency-free rule model: correct in an
// air-gap, instant, and explainable. A hosted LLM or a local ONNX model is a swap
// behind this interface (MODEL_DRIVER env) — never a change at the call site.
//
// First capability: whose-turn classification. The naive rule (customer→us,
// agent→customer) ignores what the message SAYS; this reads light content signals
// so a customer's "thanks, that fixed it!" doesn't sit forever in Needs-reply, and
// an agent's "let me look into it" keeps the ball on our side.

export type WhoseTurn = "us" | "customer";

export interface WhoseTurnInput {
  authorType: "customer" | "agent";
  body: string;
  subject?: string | null;
}

/** A passage retrieved from the tenant's knowledge (a KB article or a document
 *  chunk) that grounds a drafted reply — the "R" in RAG. */
export interface DraftSource {
  title: string;
  text: string;
}
/** One prior turn of the conversation (oldest→newest), so the hosted model has context —
 *  who said what — and can CONTINUE its own previous reply instead of denying it exists. */
export interface DraftTurn {
  role: "customer" | "agent";
  text: string;
}
export interface DraftReplyInput {
  customerMessage: string;
  sources: DraftSource[];
  /** Prior conversation turns (oldest→newest), EXCLUDING the current customerMessage. Rendered as a
   *  transcript ahead of the latest message so a follow-up ("you didn't finish your reply") is answered
   *  WITH context, not blind. The extractive rule baseline ignores it (it only quotes sources). */
  history?: DraftTurn[];
  // Optional per-tenant voice fragment (persona.ts). Prepended to the draft system prompt so the
  // hosted model answers in the team's configured tone/signature. The extractive rule baseline
  // ignores it — it can't paraphrase, so it stays honest regardless of persona.
  persona?: string;
}

/** A drafted reply plus the signals the autoreply gate + trace store need: how
 *  confident the model is (0..1) and token usage when the driver reports it. */
export interface DraftResult {
  text: string;
  confidence?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** One event from a streaming draft: an incremental text `delta` while generating,
 *  then a single terminal event carrying the aggregate `done` result. A `delta` and
 *  `done` never co-occur on the same event. */
export interface DraftStreamEvent {
  delta?: string;
  done?: DraftResult;
}

export interface ModelServingDriver {
  readonly name: string;
  classifyWhoseTurn(input: WhoseTurnInput): Promise<WhoseTurn>;
  /**
   * Draft a suggested reply to a customer, grounded in the retrieved sources.
   * The agent always reviews before sending — this is a starting point, not an
   * auto-send. A hosted LLM generates prose here; the rule baseline composes an
   * extractive draft from the retrieved passages (honest, air-gap-safe).
   */
  draftReply(input: DraftReplyInput): Promise<DraftResult>;
  /**
   * Streaming sibling of draftReply: yield text deltas as the model generates, then a
   * terminal `done` event with the aggregate. Hosted drivers stream from the provider's
   * SSE; the rule baseline chunk-reveals its finished extractive text so callers get one
   * uniform streaming shape. Every driver here implements it, but it's OPTIONAL on the
   * interface — callers MUST feature-detect (`if (driver.draftReplyStream)`) and fall
   * back to draftReply so a future minimal driver stays valid.
   */
  draftReplyStream?(input: DraftReplyInput): AsyncIterable<DraftStreamEvent>;
  /**
   * Raw single-turn completion (system + user → text) for agentic tool-selection
   * loops. OPTIONAL: only hosted drivers implement it — the extractive rule baseline
   * has no generative reasoning, so callers MUST feature-detect (`if (driver.complete)`)
   * and fall back to a deterministic path when it's absent.
   */
  complete?(system: string, user: string): Promise<string>;
}

// Business-risk classification for the autoreply gate — a deterministic backstop
// that hard-denies auto-send on messages a human must see. Same regex style as the
// whose-turn classifiers above; deliberately trigger-happy (precision < recall by
// design — a false hold is cheap, a bad auto-send is not). A hosted sentiment/intent
// classifier is a later swap behind this same function.
export type RiskTag =
  | "refund_dispute" | "cancellation" | "escalation" | "legal"
  | "security" | "negative_sentiment" | "payment_pii";

const RISK_RULES: Array<[RiskTag, RegExp]> = [
  ["refund_dispute", /\b(refund|charge ?back|money back|dispute (the )?charge|overcharged|double charged)\b/i],
  ["cancellation", /\b(cancel|cancellation|terminate my|close my account|unsubscribe)\b/i],
  ["escalation", /\b(manager|supervisor|escalate|speak (to|with) (a |someone|a human|a real)|real person|human agent)\b/i],
  ["legal", /\b(lawyer|attorney|legal action|sue|lawsuit|gdpr|ccpa|compliance|delete my data|data deletion|right to be forgotten)\b/i],
  ["security", /\b(hacked|breach|breached|data leak|leaked|phish|fraud|unauthori[sz]ed|compromised|stolen (card|account))\b/i],
  ["negative_sentiment", /\b(angry|furious|unacceptable|ridiculous|terrible|awful|worst|disgust|outrage|frustrat|pissed|scam)\b|!!!|\bwtf\b/i],
  ["payment_pii", /\b\d{13,16}\b|\bcvv\b|\bssn\b|\bsocial security\b|card number/i],
];

/** The built-in risk tags (the always-on floor) — surfaced read-only in the classification Settings
 *  UI so a tenant sees which guardrails already fire before adding their own patterns. */
export const BUILTIN_RISK_TAGS: RiskTag[] = RISK_RULES.map(([tag]) => tag);

// A typed request to reach a human — broader than the "escalation" RISK rule above (which keys on
// "speak to" and misses the common "talk to a human"). Drives the widget handoff: a match mutes the
// assistant for that conversation and drops it into the human queue, so the bot stops auto-answering.
const HUMAN_REQUEST_RE = new RegExp(
  [
    "\\b(?:talk|speak|chat|connect|transfer|get)\\s+(?:me\\s+)?(?:to|with)?\\s*(?:a|an|the|real|live|some\\s?one)?\\s*(?:human|person|agent|representative|rep|someone)\\b",
    "\\b(?:human|live|real)\\s+(?:agent|person|rep|representative|support)\\b",
    "\\breal\\s+person\\b",
    "\\b(?:human|agent|person)\\s+please\\b",
  ].join("|"),
  "i",
);

/** True when the visitor is asking to reach a human ("talk to a human", "live agent", "human please").
 *  Deliberately recall-favoring — a false handoff just routes to a person a beat early. */
export function wantsHuman(text: string): boolean {
  return HUMAN_REQUEST_RE.test(text);
}

/**
 * Business-risk tags for a message. The built-in RISK_RULES are the always-on floor; `extra` is the
 * tenant's ADDITIVE keyword patterns (risk_keywords config, 0087) — a substring match appends that
 * tag. Additive-only by construction: a tenant can widen the guardrail (hold more), never narrow it.
 */
export function classifyRisk(
  text: string,
  extra?: Array<{ riskTag: string; keywords: string[] }>,
): RiskTag[] {
  const t = text ?? "";
  const tags = new Set<RiskTag>(RISK_RULES.filter(([, re]) => re.test(t)).map(([tag]) => tag));
  if (extra?.length) {
    const lower = t.toLowerCase();
    for (const r of extra) {
      if (r.keywords.some((k) => k && lower.includes(k.toLowerCase()))) tags.add(r.riskTag as RiskTag);
    }
  }
  return [...tags];
}

// A customer closing/confirming resolution — not waiting on us (unless they also ask).
const CUSTOMER_CLOSER =
  /\b(thanks|thank you|thx|cheers|much appreciated|that (fixed|solved|worked)|all good|works now|working now|it works|no (further )?(questions|issues|problems)|resolved|sorted|perfect)\b/i;
// An agent holding the ticket to follow up — the ball stays with us.
const AGENT_SELF_HOLD =
  /\b(i'?ll (get back|look into|look at|check|investigate|follow up|dig in)|let me (check|look|investigate|dig)|will (update|circle back|get back|follow up)|looking into|on it|give me (a|some|a few))\b/i;
// A question mark or an explicit ask — the sender is waiting on the OTHER party.
const ASKS = /\?\s*$|\?\s|\b(could you|can you|would you|please (send|share|confirm|provide|let me know)|what|when|which|where|how|why)\b/i;

/**
 * Deterministic baseline classifier. This is the bar every future model must beat
 * on the eval set — keep it tiny and explainable.
 */
export class RuleModelDriver implements ModelServingDriver {
  readonly name = "rule";

  async classifyWhoseTurn({ authorType, body }: WhoseTurnInput): Promise<WhoseTurn> {
    const text = body ?? "";
    if (authorType === "customer") {
      // A pure thank-you / confirmation isn't waiting on us — unless they also asked.
      if (CUSTOMER_CLOSER.test(text) && !ASKS.test(text)) return "customer";
      return "us";
    }
    // agent: normally the ball goes to the customer, but a self-hold keeps it ours.
    if (AGENT_SELF_HOLD.test(text)) return "us";
    return "customer";
  }

  /**
   * Extractive draft: quote the most relevant retrieved passages, framed as a
   * reply. It can't paraphrase (that's the hosted model's job), so it stays
   * honest — it surfaces what the knowledge base says and leaves the wording to
   * the agent. With no sources, it falls back to a safe acknowledgement.
   */
  async draftReply({ sources }: DraftReplyInput): Promise<DraftResult> {
    const top = sources.slice(0, 2).map((s) => clip(s.text, 320)).filter((t) => t.length > 0);
    if (top.length === 0) {
      // Honest: the extractive rule model is never confident enough to auto-send.
      return {
        text: "Hi,\n\nThanks for reaching out — I'm looking into this and will follow up shortly with more detail.\n\nBest regards",
        confidence: 0.2,
      };
    }
    return {
      text: [
        "Hi,",
        "",
        "Thanks for reaching out. Based on our documentation:",
        "",
        top.join("\n\n"),
        "",
        "Let me know if that resolves things, or if there's anything else I can help with.",
        "",
        "Best regards",
      ].join("\n"),
      confidence: sources.length >= 2 ? 0.5 : 0.2,
    };
  }

  /** The extractive baseline can't truly stream — it has the whole text up front — so it
   *  chunk-reveals word-groups on a small cadence. This keeps the streaming UX (and the
   *  air-gap / FORCE_RULE_MODEL test path) identical in shape to the hosted drivers. */
  async *draftReplyStream(input: DraftReplyInput): AsyncIterable<DraftStreamEvent> {
    const r = await this.draftReply(input);
    const parts = r.text.split(/(\s+)/); // keep whitespace as its own tokens
    let buf = "";
    for (let i = 0; i < parts.length; i++) {
      buf += parts[i];
      // Flush every ~3 word-tokens so the reveal reads like typing, not a firehose.
      if (i % 6 === 5 || i === parts.length - 1) {
        if (buf) { yield { delta: buf }; buf = ""; await sleep(14); }
      }
    }
    yield { done: r };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Trim to a length, cutting at the last sentence/word boundary so a draft never
 *  ends mid-word. */
export function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop > max * 0.5) return cut.slice(0, stop + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut) + "…";
}

// ---- Hosted chat driver (bring-your-own) --------------------------------
// A real LLM behind the drafts, reached over HTTP with per-tenant credentials
// (resolved in modelconfig.ts). Two wire shapes: OpenAI-compatible /chat/completions
// (provider openai | custom-endpoint) and Anthropic /messages. whose-turn stays on
// the deterministic rule baseline — it's cheap and sits in the ingest hot path; only
// draftReply calls the network. Any failure THROWS so the caller degrades to the
// extractive rule draft: a bad key or a quota wall never breaks the assist.

export type ChatProvider = "openai" | "anthropic" | "custom";

export interface ChatModelOptions {
  provider: ChatProvider;
  endpoint?: string | null; // base URL; defaults per provider
  model: string;
  apiKey: string;
}

const DRAFT_SYSTEM =
  "You are a customer-support agent. Write a concise, friendly reply to the customer's message, " +
  "grounded ONLY in the provided sources. Do not invent facts, prices, or policies. If the sources " +
  "do not answer the question, say you are looking into it and will follow up. Reply in the same " +
  "language the customer is writing in. Sign off politely.";

// Output ceiling for a drafted reply. 600 was too tight: non-English replies (Czech, German, …)
// tokenize ~2-3x heavier than English, so a normal-length answer hit the cap and was sent truncated
// mid-word. 1500 gives a full support reply headroom while still bounding a runaway generation.
const DRAFT_MAX_TOKENS = 1500;

function draftPrompt(input: DraftReplyInput): { system: string; user: string } {
  const sources = input.sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.text}`).join("\n\n");
  // Persona steers voice ON TOP of the grounding rules — it comes first as the framing, then the
  // non-negotiable grounding instruction, then the sources. Absent persona changes nothing.
  const persona = input.persona?.trim();
  const base = persona ? `${persona}\n\n${DRAFT_SYSTEM}` : DRAFT_SYSTEM;
  const system = sources ? `${base}\n\nSources:\n${sources}` : base;
  const latest = input.customerMessage || "(the customer has not written anything yet)";
  // Render prior turns as a labeled transcript so the model can see the conversation — without it a
  // follow-up like "you didn't finish, continue?" is answered blind (the model denies its own reply).
  // The latest customer message is presented last, as the turn to answer.
  const history = (input.history ?? []).filter((t) => t.text && t.text.trim());
  if (history.length === 0) return { system, user: latest };
  const transcript = history
    .map((t) => `${t.role === "agent" ? "You (support agent)" : "Customer"}: ${t.text.trim()}`)
    .join("\n\n");
  const user = `Conversation so far:\n${transcript}\n\nThe customer's latest message (reply to this):\n${latest}`;
  return { system, user };
}

export class HttpChatModelDriver implements ModelServingDriver {
  readonly name: string;
  private readonly rule = new RuleModelDriver();

  constructor(private readonly opts: ChatModelOptions) {
    this.name = `${opts.provider}:${opts.model}`;
  }

  classifyWhoseTurn(input: WhoseTurnInput): Promise<WhoseTurn> {
    return this.rule.classifyWhoseTurn(input);
  }

  async draftReply(input: DraftReplyInput): Promise<DraftResult> {
    const { system, user } = draftPrompt(input);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const r =
        this.opts.provider === "anthropic"
          ? await this.anthropic(system, user, ctrl.signal)
          : await this.openaiCompatible(system, user, ctrl.signal);
      const text = r.text.trim();
      if (!text) throw new Error("empty completion");
      // A hosted model is more trustworthy than the extractive baseline, but not
      // blindly — 0.7 is a sane default until real per-tenant eval data tunes it.
      return { text, confidence: 0.7, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Streaming draft: open the provider's SSE stream and re-yield text deltas as they
   *  arrive, then a terminal `done` with the aggregate text + token usage. Same 0.7
   *  confidence and grounding prompt as draftReply. Any failure throws so the caller can
   *  degrade to the extractive baseline. */
  async *draftReplyStream(input: DraftReplyInput): AsyncIterable<DraftStreamEvent> {
    const { system, user } = draftPrompt(input);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const gen =
        this.opts.provider === "anthropic"
          ? this.anthropicStream(system, user, ctrl.signal)
          : this.openaiStream(system, user, ctrl.signal);
      let text = "";
      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      for await (const ev of gen) {
        if (ev.delta) {
          text += ev.delta;
          yield { delta: ev.delta };
        }
        if (ev.tokensIn != null) tokensIn = ev.tokensIn;
        if (ev.tokensOut != null) tokensOut = ev.tokensOut;
      }
      text = text.trim();
      if (!text) throw new Error("empty completion");
      yield { done: { text, confidence: 0.7, tokensIn, tokensOut } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Raw completion for the agent-node tool loop — same wire shapes as draftReply,
   *  no source-grounding system prompt (the caller owns the whole prompt). */
  async complete(system: string, user: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25_000);
    try {
      const r =
        this.opts.provider === "anthropic"
          ? await this.anthropic(system, user, ctrl.signal)
          : await this.openaiCompatible(system, user, ctrl.signal);
      return r.text.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  private base(): string {
    if (this.opts.endpoint) return this.opts.endpoint.replace(/\/+$/, "");
    return this.opts.provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
  }

  private async openaiCompatible(
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: DRAFT_MAX_TOKENS,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`chat ${res.status}: ${clip(await res.text(), 200)}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      tokensIn: data.usage?.prompt_tokens,
      tokensOut: data.usage?.completion_tokens,
    };
  }

  private async anthropic(
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
    const res = await fetch(`${this.base()}/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: DRAFT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${clip(await res.text(), 200)}`);
    const data = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: data.content?.map((b) => b.text ?? "").join("") ?? "",
      tokensIn: data.usage?.input_tokens,
      tokensOut: data.usage?.output_tokens,
    };
  }

  // ---- streaming transports (SSE) ----------------------------------------

  /** Yield decoded SSE `data:` payload strings from a fetch Response body, reassembling
   *  partial chunks across reads. Comment lines and non-data fields are skipped. */
  private async *sseData(res: Response, label: string): AsyncIterable<string> {
    if (!res.ok || !res.body) throw new Error(`${label} ${res.status}: ${clip(await res.text().catch(() => ""), 200)}`);
    const decoder = new TextDecoder();
    let buf = "";
    // undici's Response.body is async-iterable (Uint8Array chunks).
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }

  private async *anthropicStream(
    system: string,
    user: string,
    signal: AbortSignal,
  ): AsyncIterable<{ delta?: string; tokensIn?: number; tokensOut?: number }> {
    const res = await fetch(`${this.base()}/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: DRAFT_MAX_TOKENS,
        system,
        stream: true,
        messages: [{ role: "user", content: user }],
      }),
    });
    for await (const data of this.sseData(res, "anthropic")) {
      if (!data || data === "[DONE]") continue;
      let ev: {
        type?: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        yield { delta: ev.delta.text };
      } else if (ev.type === "message_start" && ev.message?.usage?.input_tokens != null) {
        yield { tokensIn: ev.message.usage.input_tokens };
      } else if (ev.type === "message_delta" && ev.usage?.output_tokens != null) {
        yield { tokensOut: ev.usage.output_tokens };
      }
    }
  }

  private async *openaiStream(
    system: string,
    user: string,
    signal: AbortSignal,
  ): AsyncIterable<{ delta?: string; tokensIn?: number; tokensOut?: number }> {
    const res = await fetch(`${this.base()}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: DRAFT_MAX_TOKENS,
        temperature: 0.3,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    for await (const data of this.sseData(res, "chat")) {
      if (!data || data === "[DONE]") continue;
      let ev: {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const piece = ev.choices?.[0]?.delta?.content;
      if (piece) yield { delta: piece };
      if (ev.usage) yield { tokensIn: ev.usage.prompt_tokens, tokensOut: ev.usage.completion_tokens };
    }
  }
}

// ---- Embedding seam (for semantic retrieval / RAG) -----------------------
// The document-ingestion pipeline chunks + keyword-indexes today. Semantic
// retrieval needs vectors: an EmbeddingDriver turns chunk text into embeddings
// that a vector store (Qdrant) indexes. The DEFAULT is a no-op (returns null) so
// the pipeline runs keyword-only with no external dependency; a local ONNX model
// or a hosted embeddings API is a swap behind this interface (EMBED_DRIVER env).

export interface EmbeddingDriver {
  readonly name: string;
  /** Returns one vector per input, or null when embeddings are disabled. */
  embed(texts: string[]): Promise<number[][] | null>;
}

class NoopEmbeddingDriver implements EmbeddingDriver {
  readonly name = "noop";
  async embed(): Promise<number[][] | null> {
    return null; // keyword-only retrieval until a real embedding driver is wired
  }
}

/**
 * Calls the self-hosted `embedder` sidecar over the project network (keyless,
 * internal HTTP). The sidecar owns the ONNX model + native runtime, keeping this
 * process (and its lean stage bundle) free of native deps. Returns null on failure
 * so retrieval degrades to keyword-only rather than breaking.
 */
class ServiceEmbeddingDriver implements EmbeddingDriver {
  readonly name = "service";
  private readonly url = process.env.EMBED_URL ?? "http://embedderdev:3001";

  async embed(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return [];
    try {
      const res = await fetch(`${this.url}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      if (!res.ok) throw new Error(`embedder ${res.status}`);
      const data = (await res.json()) as { vectors: number[][] };
      return data.vectors;
    } catch {
      return null; // degrade to keyword-only retrieval
    }
  }
}

export function getEmbeddingDriver(): EmbeddingDriver {
  switch (process.env.EMBED_DRIVER) {
    case "service":
      return new ServiceEmbeddingDriver(); // self-hosted sidecar (all-MiniLM)
    // case "hosted": return new HostedEmbeddingDriver(); // embeddings API
    default:
      return new NoopEmbeddingDriver();
  }
}

export const embeddingDriver = getEmbeddingDriver();

/** Select the active driver. Extend the switch to add a hosted/ONNX driver — the
 *  call sites and the eval harness stay identical. */
export function getModelDriver(): ModelServingDriver {
  switch (process.env.MODEL_DRIVER) {
    // case "onnx":   return new OnnxModelDriver();   // local model, air-gap ok
    // case "hosted": return new HostedModelDriver(); // LLM API, pooled/dedicated
    default:
      return new RuleModelDriver();
  }
}

export const modelDriver = getModelDriver();
