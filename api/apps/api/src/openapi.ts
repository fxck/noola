// Hand-authored OpenAPI 3.1 document for the PUBLIC API (the /v1/public/* surface). Served at
// GET /openapi.json so integrators — and codegen tools — have a machine-readable contract. Kept
// deliberately small and in lockstep with the public handlers + the Zod contracts they validate.

export function buildOpenApiSpec(serverUrl?: string) {
  const apiKeyScheme = { type: "apiKey", in: "header", name: "x-api-key" } as const;
  const errorSchema = {
    type: "object",
    properties: { error: { description: "Error message or validation detail" } },
  };
  const jsonBody = (schema: unknown) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const jsonResp = (description: string, schema: unknown) => ({
    description,
    content: { "application/json": { schema } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Noola Public API",
      version: "1.0.0",
      description:
        "Programmatic access to answers, tickets, and CSAT. Authenticate with an API key " +
        "(Settings → API keys) sent as the `x-api-key` header. Each key is scoped; endpoints " +
        "are rate-limited per key (see the `x-ratelimit-*` response headers).",
    },
    servers: [{ url: serverUrl ? `${serverUrl}/v1` : "/v1" }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: { ApiKeyAuth: apiKeyScheme },
      schemas: {
        Error: errorSchema,
        Citation: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["kb", "document", "thread"] },
            title: { type: "string" },
            snippet: { type: "string" },
          },
        },
        AnswerRequest: {
          type: "object",
          required: ["question"],
          properties: { question: { type: "string", maxLength: 4000 } },
        },
        AnswerResponse: {
          type: "object",
          properties: {
            answer: { type: "string" },
            citations: { type: "array", items: { $ref: "#/components/schemas/Citation" } },
            confidence: { type: "number", nullable: true },
            uncertain: { type: "boolean" },
            model: { type: "string" },
          },
        },
        TicketCreateRequest: {
          type: "object",
          required: ["body"],
          properties: {
            subject: { type: "string", maxLength: 200 },
            body: { type: "string", maxLength: 8000 },
            channelType: { type: "string", maxLength: 40 },
            externalId: { type: "string", maxLength: 200 },
          },
        },
        Ticket: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            subject: { type: "string" },
            status: { type: "string", enum: ["open", "closed"] },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            tags: { type: "array", items: { type: "string" } },
            channelType: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        CsatRequest: {
          type: "object",
          required: ["ticketId", "rating"],
          properties: {
            ticketId: { type: "string", format: "uuid" },
            rating: { type: "integer", minimum: 1, maximum: 5 },
            comment: { type: "string", maxLength: 2000 },
          },
        },
      },
      responses: {
        Unauthorized: jsonResp("Missing or invalid API key", { $ref: "#/components/schemas/Error" }),
        Forbidden: jsonResp("API key lacks the required scope", { $ref: "#/components/schemas/Error" }),
        RateLimited: jsonResp("Rate limit exceeded for this key", { $ref: "#/components/schemas/Error" }),
      },
    },
    paths: {
      "/public/answer": {
        post: {
          summary: "Ask a question — grounded, cited AI answer",
          operationId: "answer",
          description: "Scope: `answer`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/AnswerRequest" }),
          responses: {
            "200": jsonResp("The answer + citations", { $ref: "#/components/schemas/AnswerResponse" }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/public/tickets": {
        post: {
          summary: "Create a ticket",
          operationId: "createTicket",
          description: "Scope: `tickets:write`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/TicketCreateRequest" }),
          responses: {
            "201": jsonResp("Created", {
              type: "object",
              properties: {
                ticketId: { type: "string", format: "uuid" },
                messageId: { type: "string", format: "uuid" },
                created: { type: "boolean" },
              },
            }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/public/tickets/list": {
        post: {
          summary: "List tickets",
          operationId: "listTickets",
          description: "Scope: `tickets:read`.",
          requestBody: jsonBody({
            type: "object",
            properties: {
              status: { type: "string", enum: ["open", "closed", "all"] },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            },
          }),
          responses: {
            "200": jsonResp("Tickets page", {
              type: "object",
              properties: { tickets: { type: "array", items: { $ref: "#/components/schemas/Ticket" } } },
            }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/public/csat": {
        post: {
          summary: "Submit a CSAT rating for a ticket",
          operationId: "submitCsat",
          description: "Scope: `tickets:write`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/CsatRequest" }),
          responses: {
            "201": jsonResp("Recorded", {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                ticketId: { type: "string", format: "uuid" },
                rating: { type: "integer" },
                createdAt: { type: "string", format: "date-time" },
              },
            }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": jsonResp("Ticket not found", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
    },
  };
}
