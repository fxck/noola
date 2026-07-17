import { suggestForQuery } from "./copilot.js";
import { searchArticles } from "./kb.js";
import { ingestInbound } from "./ingest.js";
import { queryTickets } from "./tickets.js";

// MCP (Model Context Protocol) server — a JSON-RPC 2.0 endpoint over HTTP that exposes the
// tenant's knowledge + ticket actions as tools an AI coding agent (Claude Desktop, Cursor, …)
// can call. Same api-key auth + scopes as the REST public API; the resolved key is passed in.
// We implement the wire protocol directly (initialize / tools/list / tools/call) — small,
// dependency-free, and enough for a real client to connect and call tools.

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "noola-mcp", version: "1.0.0" };

interface ResolvedKey {
  tenantId: string;
  scopes: string[];
}

// Each tool declares the api-key scope it needs and its JSON-Schema input.
interface McpTool {
  name: string;
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
  run: (key: ResolvedKey, args: Record<string, unknown>) => Promise<string>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const TOOLS: McpTool[] = [
  {
    name: "search_knowledge",
    description:
      "Search the workspace knowledge base for articles relevant to a query. Returns matching titles and snippets.",
    scope: "answer",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
    run: async (key, args) => {
      const articles = await searchArticles(key.tenantId, str(args.query));
      if (articles.length === 0) return "No matching articles.";
      return articles
        .slice(0, 8)
        .map((a) => `# ${a.title}\n${str(a.body).slice(0, 500)}`)
        .join("\n\n---\n\n");
    },
  },
  {
    name: "answer_question",
    description:
      "Answer a question grounded in the workspace knowledge base, with citations. Use for factual product/support questions.",
    scope: "answer",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", description: "The question to answer" } },
      required: ["question"],
    },
    run: async (key, args) => {
      const s = await suggestForQuery(key.tenantId, str(args.question), {});
      const cites = s.citations.map((c) => `- ${c.title}`).join("\n");
      const uncertain = s.citations.length === 0 || (s.confidence ?? 0) < 0.5;
      return `${s.draft}\n\n${cites ? `Sources:\n${cites}` : "(no sources)"}${uncertain ? "\n\n[uncertain — consider routing to a human]" : ""}`;
    },
  },
  {
    name: "create_ticket",
    description: "Open a support ticket in the workspace on behalf of a customer.",
    scope: "tickets:write",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string", description: "The ticket message body" },
      },
      required: ["body"],
    },
    run: async (key, args) => {
      const body = str(args.body);
      const result = await ingestInbound({
        tenantId: key.tenantId,
        body,
        authorType: "customer",
        channelType: "api",
        subject: str(args.subject) || body.slice(0, 80),
      });
      return `Created ticket ${result.ticketId} (new=${result.ticketCreated}).`;
    },
  },
  {
    name: "list_tickets",
    description: "List recent tickets in the workspace (newest first).",
    scope: "tickets:read",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed", "all"] },
        limit: { type: "number" },
      },
    },
    run: async (key, args) => {
      const status = args.status === "open" || args.status === "closed" ? args.status : "all";
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const { rows } = await queryTickets(key.tenantId, {
        status: status as "open" | "closed" | "all",
        limit,
        offset: 0,
        sortBy: "updated_at",
        sortDir: "desc",
      });
      if (rows.length === 0) return "No tickets.";
      return rows
        .map((t) => `- [${t.status}] ${t.subject} (priority=${t.priority}, id=${t.id})`)
        .join("\n");
    },
  },
];

// JSON-RPC 2.0 shapes. A request with no `id` is a notification (no response).
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function result(id: unknown, value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}
function error(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC message. Returns the response object, or null for notifications. */
export async function handleMcp(body: JsonRpcRequest, key: ResolvedKey): Promise<object | null> {
  const { id, method, params } = body;
  const isNotification = id === undefined;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = str(params?.name);
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return error(id, -32602, `unknown tool: ${name}`);
      if (!key.scopes.includes(tool.scope)) {
        // Tool errors are surfaced in-band (isError), not as protocol errors.
        return result(id, {
          content: [{ type: "text", text: `API key missing '${tool.scope}' scope for ${name}.` }],
          isError: true,
        });
      }
      try {
        const text = await tool.run(key, args);
        return result(id, { content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return result(id, {
          content: [{ type: "text", text: `Tool failed: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return error(id, -32601, `method not found: ${method ?? "?"}`);
  }
}

/** The tools list, for a public discovery route (no auth needed to see what exists). */
export function mcpToolManifest() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, scope: t.scope }));
}
