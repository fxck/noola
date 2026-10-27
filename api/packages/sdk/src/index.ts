/**
 * @repo/sdk — a tiny, dependency-free typed client for the Noola public API.
 *
 * Everything the API does, the SDK does: ask a grounded question, create + list tickets,
 * submit CSAT. Authenticate with an API key (Settings → API keys). Uses the global `fetch`
 * (Node 18+, Deno, browsers, edge runtimes) — no runtime dependencies.
 *
 *   import { NoolaClient } from "@repo/sdk";
 *   const noola = new NoolaClient({ apiKey: "sk_live_…", baseUrl: "https://api.example.com" });
 *   const { answer, citations } = await noola.answer("How do I reset my password?");
 *   const { ticketId } = await noola.createTicket({ body: "Billing is broken", subject: "Help" });
 *   await noola.submitCsat({ ticketId, rating: 5, comment: "Fast fix!" });
 */

export interface NoolaClientOptions {
  /** Your secret API key (`sk_…`). Create one in Settings → API keys. */
  apiKey: string;
  /** API origin, e.g. "https://api.example.com". The client targets the `/v1` surface. */
  baseUrl: string;
  /** Optional fetch override (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface Citation {
  kind: "kb" | "document" | "thread";
  title: string;
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  confidence: number | null;
  /** True when nothing corroborated the answer or confidence is low — route to a human. */
  uncertain: boolean;
  model: string;
}

export interface CreateTicketInput {
  body: string;
  subject?: string;
  channelType?: string;
  externalId?: string;
}

export interface CreateTicketResult {
  ticketId: string;
  messageId: string;
  created: boolean;
}

export interface PublicTicket {
  id: string;
  subject: string;
  status: "open" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  tags: string[];
  channelType: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitCsatInput {
  ticketId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
}

/** Thrown on any non-2xx response. `status` is the HTTP code; `body` is the parsed payload. */
export class NoolaApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`Noola API error ${status}`);
    this.name = "NoolaApiError";
  }
}

export class NoolaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(options: NoolaClientOptions) {
    if (!options.apiKey) throw new Error("NoolaClient: apiKey is required");
    if (!options.baseUrl) throw new Error("NoolaClient: baseUrl is required");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.doFetch = options.fetch ?? globalThis.fetch;
    if (!this.doFetch) throw new Error("NoolaClient: no fetch available — pass options.fetch");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}/v1/public${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new NoolaApiError(res.status, parsed);
    return parsed as T;
  }

  /** Ask a question — returns a grounded, cited answer. Scope: `answer`. */
  answer(question: string): Promise<AnswerResult> {
    return this.post<AnswerResult>("/answer", { question });
  }

  /** Create a ticket. Scope: `tickets:write`. */
  createTicket(input: CreateTicketInput): Promise<CreateTicketResult> {
    return this.post<CreateTicketResult>("/tickets", input);
  }

  /** List tickets (newest first). Scope: `tickets:read`. */
  async listTickets(opts?: { status?: "open" | "closed" | "all"; limit?: number }): Promise<PublicTicket[]> {
    const { tickets } = await this.post<{ tickets: PublicTicket[] }>("/tickets/list", opts ?? {});
    return tickets;
  }

  /** Submit a CSAT rating for a resolved ticket. Scope: `tickets:write`. */
  submitCsat(input: SubmitCsatInput): Promise<{ id: string; ticketId: string; rating: number; createdAt: string }> {
    return this.post("/csat", input);
  }
}
