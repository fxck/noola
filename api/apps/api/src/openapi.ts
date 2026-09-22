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
        "Programmatic access to answers, tickets, CSAT, contacts, and accounts (clients, projects, technologies). Authenticate with an API key " +
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
        ContactUpsertRequest: {
          type: "object",
          required: ["external_id"],
          description:
            "Matched by `external_id` (your stable id). With no id match, a contact holding `email` and no " +
            "external_id yet gets the id attached (matched_by = email). An email held by a contact with a " +
            "different external_id is a conflict. Omitted fields stay unchanged.",
          properties: {
            external_id: { type: "string", minLength: 1, maxLength: 200 },
            email: { type: "string", format: "email", maxLength: 320 },
            name: { type: "string", maxLength: 300 },
            subscribed: {
              type: "boolean",
              description:
                "Marketing consent. false opts out. true re-subscribes only an opt-out made via the API; " +
                "otherwise the row gets the `resubscribe_blocked` warning (use /contacts/subscription with force).",
            },
          },
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            external_id: { type: "string", nullable: true },
            email: { type: "string", nullable: true },
            name: { type: "string" },
            subscribed: { type: "boolean" },
            unsubscribed_at: { type: "string", format: "date-time", nullable: true },
            unsubscribed_source: { type: "string", enum: ["api", "contact", "agent", "import"], nullable: true },
            account_status: {
              type: "string", enum: ["customer", "user", "former", "lead"],
              description: "customer = synced member of a live synced company; user = synced, no live company; former = removed in your system; lead = never synced.",
            },
            synced_at: { type: "string", format: "date-time", nullable: true },
            sync_removed_at: { type: "string", format: "date-time", nullable: true },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        ExternalIdRequest: {
          type: "object",
          required: ["external_id"],
          properties: { external_id: { type: "string", minLength: 1, maxLength: 200 } },
        },
        Service: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", description: "Resolved service type, e.g. `ubuntu/nodejs@22`, `postgresql:ha@16`, `php-nginx@8.4+1.22`." },
            hostname: { type: "string" },
            external_id: { type: "string" },
          },
        },
        CompanySnapshot: {
          type: "object",
          required: ["external_id"],
          description:
            "A client, keyed by external_id only (never by name). `members` and `projects`, when present, REPLACE " +
            "what the previous sync wrote (manual links made by agents are kept); omitted = unchanged. Sync the " +
            "people (contacts/upsert) before listing them as members.",
          properties: {
            external_id: { type: "string", minLength: 1, maxLength: 200 },
            name: { type: "string", maxLength: 300 },
            avg_monthly_spend: { type: "number", minimum: 0, nullable: true },
            currency: { type: "string", minLength: 3, maxLength: 3 },
            members: {
              type: "array", maxItems: 2000,
              items: { type: "object", required: ["external_id"], properties: { external_id: { type: "string" }, role: { type: "string" } } },
            },
            projects: {
              type: "array", maxItems: 1000,
              items: {
                type: "object", required: ["external_id"],
                properties: {
                  external_id: { type: "string" }, name: { type: "string" }, status: { type: "string" },
                  avg_monthly_spend: { type: "number", minimum: 0, nullable: true },
                  services: { type: "array", maxItems: 300, items: { $ref: "#/components/schemas/Service" } },
                },
              },
            },
          },
        },
        Company: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            external_id: { type: "string" },
            name: { type: "string" },
            avg_monthly_spend: { type: "number", nullable: true },
            currency: { type: "string", nullable: true },
            account_status: { type: "string", enum: ["customer", "former", "other"] },
            synced_at: { type: "string", format: "date-time", nullable: true },
            sync_removed_at: { type: "string", format: "date-time", nullable: true },
            members: { type: "array", items: { type: "object" } },
            projects: { type: "array", items: { type: "object" } },
          },
        },
        ContactUpsertResponse: {
          type: "object",
          properties: {
            contact: { $ref: "#/components/schemas/Contact" },
            created: { type: "boolean" },
            matched_by: { type: "string", enum: ["external_id", "email"], nullable: true },
            warnings: { type: "array", items: { type: "string", enum: ["resubscribe_blocked"] } },
          },
        },
        ContactConflict: {
          type: "object",
          properties: {
            error: { type: "string" },
            conflict: {
              type: "object",
              description: "The contact already holding the email (absent on a concurrent-write race — retry).",
              properties: {
                contact_id: { type: "string", format: "uuid" },
                external_id: { type: "string", nullable: true },
              },
            },
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
      "/public/contacts/upsert": {
        post: {
          summary: "Create or update a contact by external_id",
          operationId: "upsertContact",
          description: "Scope: `contacts:write`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ContactUpsertRequest" }),
          responses: {
            "200": jsonResp("Updated", { $ref: "#/components/schemas/ContactUpsertResponse" }),
            "201": jsonResp("Created", { $ref: "#/components/schemas/ContactUpsertResponse" }),
            "400": jsonResp("Validation error", { $ref: "#/components/schemas/Error" }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "409": jsonResp("Email belongs to another contact", { $ref: "#/components/schemas/ContactConflict" }),
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/public/contacts/bulk": {
        post: {
          summary: "Upsert up to 1000 contacts, with a result per row",
          operationId: "bulkUpsertContacts",
          description:
            "Scope: `contacts:write`. Rows apply in order; an invalid or conflicting row is reported and " +
            "skipped, every other row is saved.",
          requestBody: jsonBody({
            type: "object",
            required: ["contacts"],
            properties: {
              contacts: { type: "array", minItems: 1, maxItems: 1000, items: { $ref: "#/components/schemas/ContactUpsertRequest" } },
            },
          }),
          responses: {
            "200": jsonResp("Per-row results", {
              type: "object",
              properties: {
                created: { type: "integer" },
                updated: { type: "integer" },
                conflicts: { type: "integer" },
                invalid: { type: "integer" },
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      index: { type: "integer" },
                      external_id: { type: "string", nullable: true },
                      status: { type: "string", enum: ["created", "updated", "conflict", "invalid"] },
                      contact_id: { type: "string", format: "uuid" },
                      matched_by: { type: "string", enum: ["external_id", "email"], nullable: true },
                      warnings: { type: "array", items: { type: "string", enum: ["resubscribe_blocked"] } },
                      error: { description: "Conflict message or validation detail" },
                      conflict: { $ref: "#/components/schemas/ContactConflict/properties/conflict" },
                    },
                  },
                },
              },
            }),
            "400": jsonResp("Malformed body", { $ref: "#/components/schemas/Error" }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/public/contacts": {
        get: {
          summary: "Get a contact by external_id",
          operationId: "getContact",
          description: "Scope: `contacts:read`.",
          parameters: [{ name: "external_id", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": jsonResp("The contact", { type: "object", properties: { contact: { $ref: "#/components/schemas/Contact" } } }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": jsonResp("No contact with that external_id", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
      "/public/contacts/subscription": {
        post: {
          summary: "Set a contact's marketing consent",
          operationId: "setContactSubscription",
          description:
            "Scope: `contacts:write`. Opting out always succeeds. Re-subscribing a contact who opted out " +
            "outside the API (own unsubscribe link, an agent, an import) returns 409 unless `force` is true " +
            "— send force only when the person consented again in your system. Forced re-subscribes are audited.",
          requestBody: jsonBody({
            type: "object",
            required: ["external_id", "subscribed"],
            properties: {
              external_id: { type: "string", minLength: 1, maxLength: 200 },
              subscribed: { type: "boolean" },
              force: { type: "boolean" },
            },
          }),
          responses: {
            "200": jsonResp("Updated", { type: "object", properties: { contact: { $ref: "#/components/schemas/Contact" } } }),
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
            "404": jsonResp("No contact with that external_id", { $ref: "#/components/schemas/Error" }),
            "409": jsonResp("Re-subscribe blocked (opted out outside the API)", {
              type: "object",
              properties: {
                error: { type: "string", enum: ["resubscribe_blocked"] },
                detail: { type: "string" },
                unsubscribed_at: { type: "string", format: "date-time", nullable: true },
                unsubscribed_source: { type: "string", enum: ["contact", "agent", "import"], nullable: true },
              },
            }),
          },
        },
      },
      "/public/contacts/remove": {
        post: {
          summary: "Mark a person as removed in your system",
          operationId: "removeContact",
          description: "Scope: `contacts:write`. Soft: the contact and its history stay; it becomes `former` and loses its synced company memberships. A later upsert revives it.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExternalIdRequest" }),
          responses: {
            "200": jsonResp("Removed", { type: "object", properties: { contact: { $ref: "#/components/schemas/Contact" } } }),
            "404": jsonResp("No contact with that external_id", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
      "/public/contacts/topics": {
        post: {
          summary: "Opt a contact out of / back into one subscription topic",
          operationId: "setContactTopic",
          description: "Scope: `contacts:write`. The global opt-out (contacts/subscription) still overrides every topic.",
          requestBody: jsonBody({
            type: "object", required: ["external_id", "topic_id", "subscribed"],
            properties: { external_id: { type: "string" }, topic_id: { type: "string", format: "uuid" }, subscribed: { type: "boolean" } },
          }),
          responses: {
            "200": jsonResp("The contact's topic states", { type: "object", properties: { topics: { type: "array", items: { type: "object" } } } }),
            "404": jsonResp("Contact or topic not found", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
      "/public/topics": {
        get: {
          summary: "List subscription topics",
          operationId: "listTopics",
          description: "Scope: `contacts:read`.",
          responses: { "200": jsonResp("Topics", { type: "object", properties: { topics: { type: "array", items: { type: "object" } } } }) },
        },
      },
      "/public/companies/upsert": {
        post: {
          summary: "Sync one client snapshot (spend, members, projects + services)",
          operationId: "syncCompany",
          description: "Scope: `accounts:write`.",
          requestBody: jsonBody({ $ref: "#/components/schemas/CompanySnapshot" }),
          responses: {
            "200": jsonResp("Updated", { type: "object", properties: { company: { $ref: "#/components/schemas/Company" }, created: { type: "boolean" }, unknown_members: { type: "array", items: { type: "string" } } } }),
            "201": jsonResp("Created", { type: "object", properties: { company: { $ref: "#/components/schemas/Company" }, created: { type: "boolean" }, unknown_members: { type: "array", items: { type: "string" } } } }),
            "400": jsonResp("Validation error", { $ref: "#/components/schemas/Error" }),
            "409": jsonResp("Concurrent write — retry", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
      "/public/companies/bulk": {
        post: {
          summary: "Sync up to 200 client snapshots, with a result per row",
          operationId: "bulkSyncCompanies",
          description: "Scope: `accounts:write`.",
          requestBody: jsonBody({ type: "object", required: ["companies"], properties: { companies: { type: "array", maxItems: 200, items: { $ref: "#/components/schemas/CompanySnapshot" } } } }),
          responses: { "200": jsonResp("Per-row results", { type: "object" }) },
        },
      },
      "/public/companies": {
        get: {
          summary: "Get a client by external_id",
          operationId: "getCompany",
          description: "Scope: `accounts:read`.",
          parameters: [{ name: "external_id", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": jsonResp("The client", { type: "object", properties: { company: { $ref: "#/components/schemas/Company" } } }),
            "404": jsonResp("Not found", { $ref: "#/components/schemas/Error" }),
          },
        },
      },
      "/public/companies/remove": {
        post: {
          summary: "Mark a client as removed in your system",
          operationId: "removeCompany",
          description: "Scope: `accounts:write`. Soft: the company stays (former); its projects are deleted.",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExternalIdRequest" }),
          responses: { "200": jsonResp("Removed", { type: "object", properties: { company: { $ref: "#/components/schemas/Company" } } }) },
        },
      },
      "/public/technologies": {
        put: {
          summary: "Replace the technology catalog",
          operationId: "putTechnologies",
          description: "Scope: `accounts:write`. Keys, aliases (e.g. golang → go) and per-version lifecycle status (supported / deprecated / eol). A pushed catalog is a MANUAL catalog: it turns off Noola's own daily Zerops import (Technologies → Use Zerops catalog), and an in-use version it doesn't list reads as unknown rather than EOL.",
          requestBody: jsonBody({
            type: "object", required: ["technologies"],
            properties: { technologies: { type: "array", items: { type: "object", required: ["key"], properties: {
              key: { type: "string" }, name: { type: "string" }, category: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              versions: { type: "array", items: { type: "object", properties: { version: { type: "string" }, status: { type: "string", enum: ["supported", "deprecated", "eol"] } } } },
            } } } },
          }),
          responses: { "200": jsonResp("Replaced", { type: "object" }) },
        },
        get: {
          summary: "Technology usage per version",
          operationId: "technologyUsage",
          description: "Scope: `accounts:read`. Services, projects, clients, reachable contacts and project spend per technology version.",
          responses: { "200": jsonResp("Usage", { type: "object", properties: { usage: { type: "array", items: { type: "object" } } } }) },
        },
      },
    },
  };
}
