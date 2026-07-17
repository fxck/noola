# @repo/sdk

A tiny, dependency-free typed client for the Noola public API. Everything the API does, the
SDK does — ask a grounded question, create & list tickets, submit CSAT.

```ts
import { NoolaClient } from "@repo/sdk";

const noola = new NoolaClient({
  apiKey: process.env.NOOLA_API_KEY!, // sk_… from Settings → API keys
  baseUrl: "https://api.example.com",  // targets the /v1 surface
});

// Grounded, cited answer
const { answer, citations, uncertain } = await noola.answer("How do I reset my password?");

// Tickets
const { ticketId } = await noola.createTicket({ subject: "Billing", body: "Charged twice" });
const open = await noola.listTickets({ status: "open", limit: 20 });

// CSAT
await noola.submitCsat({ ticketId, rating: 5, comment: "Fast fix!" });
```

Auth is an API key sent as the `x-api-key` header; each key is scoped (`answer`,
`tickets:read`, `tickets:write`) and rate-limited (see the `x-ratelimit-*` response headers).
The full contract is served as OpenAPI 3.1 at `GET /openapi.json`.
