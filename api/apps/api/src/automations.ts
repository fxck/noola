import { withTenant, relayPool } from "@repo/db";
import type {
  AutomationConditions,
  AutomationAction,
  AutomationTrigger,
  FlowGraph,
} from "@repo/contracts";
import { assignTicket, setTicketStatus, patchTicket, addTicketTags } from "./tickets.js";
import { suggestTagsAI } from "./autotag.js";
import { getEnabledTagRules } from "./tagrules.js";
import { resolveAssignee, type AssignStrategy } from "./assignments.js";
import { surveyBody } from "./surveys.js";
import { dispatchIntegration } from "./integrations.js";
import { createRun, awaitRunTerminal, subscribeRunProgress, type RunnerRun } from "./runs.js";
import { resolveModelDriver } from "./modelconfig.js";
import { clip } from "./model.js";
import { claimAnswerForAutomationReply } from "./answer-claims.js"; // DISCORD arbitration (§5.2) — preserve on merge
// ── Extracted engine sub-modules ─────────────────────────────────────────────
// registry = tool catalog + RBAC-by-effect; conditions = context/interpolation/eval;
// store = automations-table CRUD + run history + webhook routes + dedupe. This file is the
// execution engine (action/agent/graph runners + the entry points) and re-exports their surface
// so every existing importer of "./automations.js" is unchanged.
import { TOOL_REGISTRY, dryRunSuppressed } from "./automations/registry.js";
import { type Ctx, interpolate, parseHeaders, evaluateConditions, buildContext } from "./automations/conditions.js";
import { type RunTraceEntry, getAutomation, reserveOnce } from "./automations/store.js";
import { type Item, seedItem, hydrateCtxItem, inputItemsFor, runItemNode, needsBrowser } from "./automations/items.js";
export * from "./automations/registry.js";
export * from "./automations/conditions.js";
export * from "./automations/store.js";

// ── Automations (rules) engine — Agent Studio ────────────────────────────────
// A rule is WHEN <trigger> IF <conditions> THEN <actions>. runAutomations() is called
// fire-and-forget at the mutation choke points (ingest.ts + the ticket routes) with a seed
// context; it loads the tenant's enabled rules for that trigger, evaluates each rule's
// all/any condition AST against the (hydrated) context, runs the matching rule's typed
// actions in order, and logs the outcome to automation_runs. Everything is RLS-scoped via
// withTenant.
//
// RULE CHAINING: a successful state-changing action re-fires the matching domain trigger for
// OTHER rules — `assign` chains `ticket.assigned`, `set_status: closed` chains `ticket.closed`
// — so rules compose ("route Discord tickets" → "notify on assignment"). Chaining re-runs on a
// FRESH context (downstream rules see the new ticket state) and is bounded by MAX_CHAIN_DEPTH,
// so even a cyclic rule set terminates. The `reply` action still calls ingestInbound with
// origin:'automation' (ingest skips re-firing its triggers), so a reply can't cascade off
// itself — only explicit ticket state changes chain.
const MAX_CHAIN_DEPTH = 3;

// ── Action execution ────────────────────────────────────────────────────────────

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
  // The domain trigger this action re-fires for rule chaining — set only on a successful
  // state change: assign → ticket.assigned, set_status:closed → ticket.closed.
  chain?: string;
  // The graph node this result came from — stamped by runGraph for the per-node run trace.
  // Undefined/null for linear (non-graph) rules.
  nodeId?: string | null;
  // The runner_runs id, when this action enqueued a container run — lets the UI drill down.
  runId?: string | null;
  // Set by the `stop` action: halt the rest of THIS rule's actions and, at the engine, skip the
  // remaining rules for this trigger — the first-match-wins primitive routing needs (dogfood L1-C4).
  stop?: boolean;
}

// ── Live/dry execution options (the Studio "Run" surface) ─────────────────────────
// The same engine backs three call sites: the inline hooks (fire-and-forget, no opts),
// the schedule tick, and the interactive canvas "Run"/"Test". For the last, opts let us:
//  • dryRun — suppress side-effecting actions (they report what they *would* do), so a run
//    from the canvas is safe by default (no real replies/broadcasts/KB writes);
//  • awaitRun — block a `run` node on the runner's terminal result so real container output
//    enters the trace instead of a bare "enqueued";
//  • emit — stream per-node start/end events so the canvas lights nodes up live.
export interface ExecEvent {
  nodeId: string | null;
  /** "step" = an intermediate progress frame (browser agent narration) — node stays running. */
  phase: "start" | "end" | "step";
  ntype?: string;
  type?: string; // action type, on phase "end"
  ok?: boolean;
  detail?: string;
  /** base64 JPEG — a live browser-preview frame from the flow container (type "frame"). */
  frame?: string;
}
export interface ExecOpts {
  dryRun?: boolean;
  awaitRun?: boolean;
  emit?: (ev: ExecEvent) => void;
  /** The rule this execution belongs to — threads into the persisted agent_runs trace. */
  automationId?: string;
}

/** Short human summary of what a side-effecting action WOULD do (for dry-run trace detail). */
function dryRunSummary(action: AutomationAction, ctx: Ctx): string {
  switch (action.type) {
    case "reply": return `reply "${interpolate(action.body ?? "", ctx).slice(0, 60)}"`;
    case "set_status": return `set status → ${action.status ?? "closed"}`;
    case "assign": return `assign → ${action.assigneeId ?? "unassigned"}`;
    case "notify": return `notify via ${action.integrationId ?? "connector"}`;
    case "kb_upsert": return `save KB article "${interpolate(action.kbTitle ?? "", ctx).slice(0, 60)}"`;
    case "contact_update": return `upsert contact ${interpolate(action.contactEmail ?? "", ctx).slice(0, 60)}`;
    case "broadcast_send": return `send broadcast "${interpolate(action.broadcastSubject ?? "", ctx).slice(0, 60)}"`;
    case "run": return `run: ${interpolate(action.cmd ?? "", ctx).split("\n")[0].slice(0, 60)}`;
    case "http": return `${(action.method ?? "GET").toUpperCase()} ${interpolate(action.url ?? "", ctx).slice(0, 60)}`;
    case "set_priority": return `set priority → ${action.priority ?? "normal"}`;
    case "escalate": return `escalate → ${action.priority ?? "urgent"}${action.assigneeId ? " + reassign" : ""}${action.integrationId ? " + notify" : ""}`;
    case "add_tags": return `add tags ${(action.tags ?? []).join(", ").slice(0, 60)}`;
    case "apply_tag_rules": return "apply the keyword tag rules";
    case "ai_tag": return "AI auto-tag from the ticket text";
    case "survey": return `send ${action.surveyKind ?? "both"} survey`;
    default: return action.type;
  }
}

// Extract a page's <title> + readable text from raw HTML — no DOM, no deps: drop
// script/style/head noise, strip tags, decode a few common entities, collapse whitespace.
// Good enough for static docs/help pages (the KB-ingestion use case). JS-rendered SPAs need a
// headless browser (the Chromium-on-runner upgrade) — this returns their empty shell honestly.
export function extractReadable(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 300) : "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|nav|footer|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body).replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { title, text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'");
}

async function runAction(
  tenantId: string,
  action: AutomationAction,
  ctx: Ctx,
  opts: ExecOpts = {},
): Promise<ActionResult> {
  // Safe by default on an interactive run: side-effecting actions report what they'd do
  // without doing it. Read/compute nodes (http, rag draft, branch) still run so the path +
  // branch routing are real.
  if (opts.dryRun && dryRunSuppressed(action)) {
    return { type: action.type, ok: true, detail: `(dry-run) would ${dryRunSummary(action, ctx)}` };
  }
  try {
    switch (action.type) {
      case "assign": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const strategy: AssignStrategy = action.strategy ?? "specific";
        const ticketId = ctx.ticketId;
        let found = false;
        let assignedTo: string | null = null;
        if (action.teamId) {
          // Team target: land the ticket in the team's lane AND draw the assignee from the
          // team's members (empty team = lane only, unassigned) — one txn like the pool path.
          const teamId = action.teamId;
          const poolStrategy = strategy === "specific" ? "round_robin" : strategy;
          const cursorKey = action.cursorKey?.trim() || `team:${teamId}`;
          const res = await withTenant(tenantId, async (c) => {
            const assigneeId = await resolveAssignee(c, { strategy: poolStrategy, teamId, cursorKey, requiredSkills: action.requiredSkills });
            const r = await c.query(
              "UPDATE tickets SET team_id = $1, assignee_id = COALESCE($2, assignee_id), updated_at = now() WHERE id = $3 RETURNING assignee_id",
              [teamId, assigneeId, ticketId],
            );
            return r.rowCount ? { assigneeId: (r.rows[0].assignee_id as string | null) ?? null } : null;
          });
          found = Boolean(res);
          assignedTo = res?.assigneeId ?? null;
          if (found) ctx.assigneeId = assignedTo;
          return {
            type: action.type,
            ok: found,
            detail: found ? `team assigned${assignedTo ? ` → ${assignedTo}` : " (lane only)"} (${poolStrategy})` : "ticket not found",
            chain: found && assignedTo ? "ticket.assigned" : undefined,
          };
        }
        if (strategy === "specific") {
          const out = await assignTicket(tenantId, ticketId, action.assigneeId ?? action.assigneeIds?.[0] ?? null);
          found = Boolean(out);
          assignedTo = out?.assigneeId ?? null;
        } else {
          // Pool strategy: resolve the assignee (bumping the round-robin cursor) and assign in ONE
          // tenant txn, so the cursor advance and the assignment are atomic (no double-hand-out).
          const cursorKey = action.cursorKey?.trim() || `assign:${strategy}:${(action.assigneeIds ?? []).join(",")}`;
          const res = await withTenant(tenantId, async (c) => {
            const assigneeId = await resolveAssignee(c, { strategy, assigneeIds: action.assigneeIds, cursorKey, requiredSkills: action.requiredSkills });
            const r = await c.query(
              "UPDATE tickets SET assignee_id = $1, updated_at = now() WHERE id = $2 RETURNING assignee_id",
              [assigneeId, ticketId],
            );
            return r.rowCount ? { assigneeId: (r.rows[0].assignee_id as string | null) ?? null } : null;
          });
          found = Boolean(res);
          assignedTo = res?.assigneeId ?? null;
        }
        if (found) ctx.assigneeId = assignedTo;
        return {
          type: action.type,
          ok: found,
          detail: found
            ? `assigned → ${assignedTo ?? "unassigned"}${strategy !== "specific" ? ` (${strategy})` : ""}`
            : "ticket not found",
          chain: found ? "ticket.assigned" : undefined,
        };
      }
      case "set_status": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const status = action.status === "open" ? "open" : "closed";
        const out = await setTicketStatus(tenantId, ctx.ticketId, status);
        if (out) {
          // Mirror the route's resolved-thread index side-effect.
          const ticketId = ctx.ticketId;
          void import("./threads.js")
            .then((m) => (status === "closed" ? m.indexResolvedThread(tenantId, ticketId) : m.unindexThread(ticketId)))
            .catch(() => {});
        }
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `status → ${status}` : "ticket not found",
          chain: out && status === "closed" ? "ticket.closed" : undefined,
        };
      }
      case "reply": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const body = interpolate(action.body ?? "", ctx);
        if (!body.trim()) return { type: action.type, ok: false, detail: "empty reply body" };
        // ═══ DISCORD ARBITRATION GATE · answer-claims.ts · STUDIO: PRESERVE THIS LINE ON MERGE ═══
        if (!(await claimAnswerForAutomationReply(tenantId, ctx))) return { type: action.type, ok: false, detail: "answer already claimed this turn" };
        // Dynamic import breaks the ingest⇄automations cycle; origin:'automation' stops the
        // reply from re-triggering the engine (no cascade).
        const { ingestInbound } = await import("./ingest.js");
        await ingestInbound({ tenantId, body, authorType: "agent", ticketId: ctx.ticketId, origin: "automation" });
        return { type: action.type, ok: true, detail: "posted agent reply" };
      }
      case "notify": {
        if (!action.integrationId) return { type: action.type, ok: false, detail: "no integration selected" };
        const res = await dispatchIntegration(tenantId, action.integrationId, {
          subject: interpolate(action.subject ?? "Automation", ctx),
          text: interpolate(action.text ?? "", ctx),
          context: ctx,
        });
        return { type: action.type, ok: res.ok, detail: res.ok ? "notified" : res.error ?? "notify failed" };
      }
      case "run": {
        // Enqueue a runner job (async execution). createRun writes the queued runner_runs row +
        // the jobs.run outbox event in ONE txn; the runner consumes it and runs a container.
        const cmd = interpolate(action.cmd ?? "", ctx);
        const run = await createRun(tenantId, "automation", { cmd, ticketId: ctx.ticketId, creds: action.creds ?? [] });
        // Interactive run: block on the runner's terminal result so the trace shows the real
        // container output (exit + stdout/stderr) instead of a bare "enqueued". Inline hooks
        // stay fire-and-forget (awaitRun unset) — they must not hold a request on a container.
        if (opts.awaitRun) {
          const term = await awaitRunTerminal(tenantId, run.id, 30_000);
          if (!term || (term.status !== "succeeded" && term.status !== "failed")) {
            return { type: action.type, ok: false, detail: `run still ${term?.status ?? "queued"} after 30s`, runId: run.id };
          }
          const out = (term.result ?? term.error ?? "").slice(0, 500);
          return {
            type: action.type,
            ok: term.status === "succeeded",
            detail: out ? `${term.status} — ${out}` : term.status,
            runId: run.id,
          };
        }
        return { type: action.type, ok: true, detail: `enqueued run ${run.id}`, runId: run.id };
      }
      case "http": {
        const method = (action.method ?? "GET").toUpperCase();
        const url = interpolate(action.url ?? "", ctx).trim();
        if (!url) return { type: action.type, ok: false, detail: "no url" };
        const headers = parseHeaders(action.headers ?? "", ctx);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 10_000);
        try {
          const hasBody = method !== "GET" && method !== "HEAD";
          const res = await fetch(url, {
            method,
            headers,
            body: hasBody ? interpolate(action.httpBody ?? "", ctx) : undefined,
            signal: ac.signal,
          });
          // Cap the read so a huge response can't blow up the run context / downstream prompts.
          const text = (await res.text()).slice(0, 2000);
          const http: { status: number; ok: boolean; body: string; json?: unknown } = {
            status: res.status, ok: res.ok, body: text,
          };
          try { http.json = JSON.parse(text); } catch { /* body isn't JSON — leave json unset */ }
          ctx.http = http;
          return { type: action.type, ok: res.ok, detail: `${method} ${url} → ${res.status}` };
        } finally {
          clearTimeout(timer);
        }
      }
      case "set_fields": {
        // Data shaping: interpolate each `Key: Value` line and merge into ctx.vars, so later
        // nodes can reference {{vars.Key}}. Pure/compute — runs even under dryRun.
        const fields = parseHeaders(action.setFields ?? "", ctx);
        const vars = (ctx.vars as Record<string, unknown>) ?? {};
        ctx.vars = { ...vars, ...fields };
        const keys = Object.keys(fields);
        return { type: action.type, ok: true, detail: keys.length ? `set ${keys.length} field(s): ${keys.join(", ")}` : "no fields set" };
      }
      case "web_fetch": {
        // Fetch a URL and extract readable text into ctx.web — the KB-ingestion primitive
        // (pair with kb_upsert: kbBody = {{web.text}}). Read-only, so it runs under dryRun too.
        const url = interpolate(action.url ?? "", ctx).trim();
        if (!url) return { type: action.type, ok: false, detail: "no url" };
        if (!/^https?:\/\//i.test(url)) return { type: action.type, ok: false, detail: "url must start with http(s)://" };
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 10_000);
        try {
          const res = await fetch(url, { headers: { "user-agent": "NoolaBot/1.0 (+studio web_fetch)" }, signal: ac.signal });
          const html = await res.text();
          const { title, text } = extractReadable(html);
          ctx.web = { url, status: res.status, ok: res.ok, title, text: text.slice(0, 8000) };
          return { type: action.type, ok: res.ok, detail: `fetched ${(title || url).slice(0, 60)} — ${text.length} chars (${res.status})` };
        } catch (e) {
          ctx.web = { url, status: 0, ok: false, title: "", text: "" };
          return { type: action.type, ok: false, detail: `fetch failed: ${(e as Error).message}` };
        } finally {
          clearTimeout(timer);
        }
      }
      case "browser_extract": {
        // The Chromium-on-runner upgrade over web_fetch: render the URL in the headless-browser
        // container (JS + network settle) and extract the rendered page text into ctx.web — same
        // shape as web_fetch, so {{web.text}} + kb_upsert compose unchanged. Reuses `url`. Read-only,
        // so it runs under dryRun too (like web_fetch).
        const url = interpolate(action.url ?? "", ctx).trim();
        if (!url) return { type: action.type, ok: false, detail: "no url" };
        if (!/^https?:\/\//i.test(url)) return { type: action.type, ok: false, detail: "url must start with http(s)://" };
        // Fold into the flow-runner: run a minimal openUrl→getText graph in the Playwright container
        // (the dedicated `browser` mode is retired). One `flow` job renders the page and returns the
        // rendered <body> text as its terminal item. Wider await window than a plain run (Chromium
        // boot + render is slower).
        const graph = {
          nodes: [
            { id: "open", type: "item", config: { kind: "openUrl", url } },
            { id: "grab", type: "item", config: { kind: "getText", selector: "body" } },
          ],
          edges: [{ from: "open", to: "grab" }],
        };
        const run = await createRun(tenantId, "flow", { mode: "flow", graph, input: seedItem(ctx) });
        const term = await awaitRunTerminal(tenantId, run.id, 60_000);
        if (!term || term.status !== "succeeded") {
          ctx.web = { url, status: 0, ok: false, title: "", text: "" };
          const why = term?.status === "failed" ? (term.error ?? term.result ?? "render failed").slice(0, 200) : `still ${term?.status ?? "queued"} after 60s`;
          return { type: action.type, ok: false, detail: `browser render ${why}`, runId: run.id };
        }
        // The flow container writes result_json = { items: [...] }; the last node (getText) carries
        // the rendered page text as its item text — map it into ctx.web exactly as before.
        const items = (term.resultJson as { items?: Array<{ text?: string }> } | null)?.items ?? [];
        const text = (items.length ? String(items[items.length - 1]?.text ?? "") : "").slice(0, 8000);
        ctx.web = { url, status: 200, ok: true, title: "", text };
        return { type: action.type, ok: true, detail: `rendered ${url.slice(0, 60)} — ${text.length} chars`, runId: run.id };
      }
      case "rag": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        // Dynamic import mirrors the reply/ingest cycle-break; suggestReply runs the same grounded
        // RAG draft the copilot /suggest endpoint uses (extractive under FORCE_RULE_MODEL).
        const { suggestReply } = await import("./copilot.js");
        const s = await suggestReply(tenantId, ctx.ticketId);
        const answer = s.draft ?? "";
        const confidence = s.confidence;
        ctx.rag = { answer, confidence };
        if (action.autoReply && !opts.dryRun && answer.trim()) {
          const { ingestInbound } = await import("./ingest.js");
          await ingestInbound({ tenantId, body: answer, authorType: "agent", ticketId: ctx.ticketId, origin: "automation" });
        }
        return {
          type: action.type,
          ok: true,
          detail: action.autoReply ? `drafted + replied (conf ${confidence})` : `drafted grounded answer (conf ${confidence})`,
        };
      }
      case "kb_upsert": {
        const title = interpolate(action.kbTitle ?? "", ctx).trim();
        if (!title) return { type: action.type, ok: false, detail: "empty title" };
        const body = interpolate(action.kbBody ?? "", ctx);
        // createArticle already mirrors into Typesense (indexArticle) + Qdrant via kb.reindex;
        // we call indexArticle again to keep the keyword index authoritative + explicit.
        const { createArticle } = await import("./kb.js");
        const { indexArticle } = await import("./search.js");
        const article = await createArticle(tenantId, title, body, action.kbCollectionId ?? null);
        await indexArticle({
          id: article.id,
          tenant_id: tenantId,
          title: article.title,
          body: article.body,
          updated_at: Math.floor(new Date(article.updated_at).getTime() / 1000),
        });
        ctx.kb = { articleId: article.id };
        return { type: action.type, ok: true, detail: `indexed "${title}"` };
      }
      case "contact_update": {
        const email = interpolate(action.contactEmail ?? "", ctx).trim();
        if (!email) return { type: action.type, ok: false, detail: "empty email" };
        const name = action.contactName ? interpolate(action.contactName, ctx).trim() : undefined;
        const attributes = action.contactFields ? parseHeaders(action.contactFields, ctx) : undefined;
        const { upsertContact } = await import("./contacts.js");
        const { contact, created } = await upsertContact(tenantId, {
          email,
          name: name || undefined,
          attributes: attributes && Object.keys(attributes).length ? attributes : undefined,
        });
        ctx.contact = { id: contact.id };
        return { type: action.type, ok: true, detail: `${created ? "created" : "updated"} contact ${email}` };
      }
      case "broadcast_send": {
        const subject = interpolate(action.broadcastSubject ?? "", ctx).trim();
        const body = interpolate(action.broadcastBody ?? "", ctx);
        if (!subject || !body.trim()) return { type: action.type, ok: false, detail: "empty subject/body" };
        // Optional JSON contacts filter — interpolated then parsed; a bad/absent value targets
        // the whole directory (segment = undefined).
        let segment: Record<string, unknown> | undefined;
        if (action.broadcastSegment && action.broadcastSegment.trim()) {
          try { segment = JSON.parse(interpolate(action.broadcastSegment, ctx)) as Record<string, unknown>; }
          catch { segment = undefined; }
        }
        const { createBroadcast, sendBroadcast } = await import("./broadcasts.js");
        const bc = await createBroadcast(tenantId, { subject, body, segment });
        const sent = await sendBroadcast(tenantId, bc.id); // {status, done} — no count returned
        if (sent?.done) await sent.done; // await the background send so the run reflects completion
        ctx.broadcast = { id: bc.id };
        return { type: action.type, ok: true, detail: `broadcast "${subject}" → ${bc.recipient_count} recipient(s)` };
      }
      case "set_priority": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const priority = action.priority ?? "normal";
        const out = await patchTicket(tenantId, ctx.ticketId, { priority });
        if (out) ctx.priority = priority;
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `priority → ${priority}` : "ticket not found",
          chain: out ? "ticket.priority_changed" : undefined,
        };
      }
      case "escalate": {
        // Composite: bump priority (default urgent) + optionally reassign + optionally notify a
        // connector — the one action a flow / SLA-breach rule fires to raise a ticket's urgency.
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const priority = action.priority ?? "urgent";
        const done: string[] = [];
        const out = await patchTicket(tenantId, ctx.ticketId, { priority });
        if (out) { ctx.priority = priority; done.push(`priority → ${priority}`); }
        if (action.assigneeId) {
          const a = await assignTicket(tenantId, ctx.ticketId, action.assigneeId);
          if (a) { ctx.assigneeId = a.assigneeId; done.push(`assigned → ${a.assigneeId ?? "unassigned"}`); }
        }
        if (action.integrationId) {
          const res = await dispatchIntegration(tenantId, action.integrationId, {
            subject: interpolate(action.subject ?? "Ticket escalated", ctx),
            text: interpolate(action.text ?? `Ticket escalated to ${priority}.`, ctx),
            context: ctx,
          });
          if (res.ok) done.push("notified");
        }
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `escalated (${done.join(", ")})` : "ticket not found",
          // Escalation changes priority (and maybe assignment) — surface the priority chain so
          // downstream rules can react; assignment chain omitted to avoid a double-escalation loop.
          chain: out ? "ticket.priority_changed" : undefined,
        };
      }
      case "add_tags": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const tags = (action.tags ?? []).map((t) => t.trim()).filter(Boolean);
        if (tags.length === 0) return { type: action.type, ok: false, detail: "no tags to add" };
        const out = await addTicketTags(tenantId, ctx.ticketId, tags);
        if (out) ctx.tags = out.tags;
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `added tags: ${tags.join(", ")}` : "ticket not found",
          chain: out ? "ticket.tagged" : undefined,
        };
      }
      case "apply_tag_rules": {
        // Config-driven keyword tagging: read the tenant's tag_rules live and append the tag of
        // every rule whose keywords appear in the subject/body (substring, case-insensitive). The
        // whole keyword table in one step — so the managed autotag flow is a single node, and edits
        // to the Settings form take effect immediately (no re-projection).
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const hay = `${String(ctx.subject ?? "")}\n${String(ctx.body ?? "")}`.toLowerCase();
        const rules = await getEnabledTagRules(tenantId);
        const tags = [...new Set(
          rules
            .filter((r) => r.keywords.some((k) => { const kw = k.trim().toLowerCase(); return kw && hay.includes(kw); }))
            .map((r) => r.tag),
        )];
        if (tags.length === 0) return { type: action.type, ok: true, detail: "no keyword rules matched" };
        const out = await addTicketTags(tenantId, ctx.ticketId, tags);
        if (out) ctx.tags = out.tags;
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `tagged: ${tags.join(", ")}` : "ticket not found",
          chain: out ? "ticket.tagged" : undefined,
        };
      }
      case "ai_tag": {
        // Hosted-model classification → append topic tags. No-ops on a rule baseline (no hosted
        // model), where the deterministic keyword tag rules own the baseline. Backs the managed
        // 'autotag' AI flow (tag_settings.ai_enabled).
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const tags = await suggestTagsAI(tenantId, String(ctx.subject ?? ""), String(ctx.body ?? ""));
        if (tags.length === 0) return { type: action.type, ok: true, detail: "no AI tags (no hosted model or none suggested)" };
        const out = await addTicketTags(tenantId, ctx.ticketId, tags);
        if (out) ctx.tags = out.tags;
        return {
          type: action.type,
          ok: Boolean(out),
          detail: out ? `AI tags: ${tags.join(", ")}` : "ticket not found",
          chain: out ? "ticket.tagged" : undefined,
        };
      }
      case "survey": {
        if (!ctx.ticketId) return { type: action.type, ok: false, detail: "no ticket in context" };
        const kind = action.surveyKind ?? "both";
        const wantCsat = kind === "csat" || kind === "both";
        const wantNps = kind === "nps" || kind === "both";
        // At-most-once per dedupe key (defaults to the ticket, so reopen→reclose never re-surveys).
        const dedupeKey = action.dedupeKey?.trim() ? interpolate(action.dedupeKey, ctx) : `survey:${ctx.ticketId}`;
        const fresh = await reserveOnce(tenantId, dedupeKey);
        if (!fresh) return { type: action.type, ok: true, detail: `survey already sent (${dedupeKey})` };
        // Channel-aware delivery. Slack tickets get the native Block Kit 1–5★ CSAT prompt (nicer than
        // a "reply with stars" text line) posted into the ticket's channel; the teamId:channelId lives
        // in external_channel_id. Everything else — email/widget/etc — gets the text prompt through the
        // shared inbound core so it reaches the customer's channel + updates the thread live.
        // origin:'automation' stops it re-triggering the engine.
        const extId = typeof ctx.externalChannelId === "string" ? ctx.externalChannelId : "";
        if (wantCsat && ctx.channelType === "slack" && extId.includes(":")) {
          const [teamId, ...rest] = extId.split(":");
          const channelId = rest.join(":");
          const { postCsatPrompt } = await import("./slack-triage.js");
          await postCsatPrompt(tenantId, teamId, channelId, ctx.ticketId);
          // NPS has no Slack button flow — append the text NPS line when requested.
          if (wantNps) {
            const { ingestInbound } = await import("./ingest.js");
            await ingestInbound({ tenantId, ticketId: ctx.ticketId, body: surveyBody(false, true), authorType: "agent", origin: "automation" });
          }
          return { type: action.type, ok: true, detail: `delivered Slack CSAT prompt${wantNps ? " + nps" : ""}` };
        }
        const { ingestInbound } = await import("./ingest.js");
        await ingestInbound({ tenantId, ticketId: ctx.ticketId, body: surveyBody(wantCsat, wantNps), authorType: "agent", origin: "automation" });
        return { type: action.type, ok: true, detail: `delivered ${kind} survey` };
      }
      case "stop": {
        // Flow control: halt this rule's remaining actions and (at the engine) the remaining rules
        // for this trigger — the first-match-wins primitive routing needs.
        return { type: action.type, ok: true, detail: "stop — first match wins", stop: true };
      }
      default:
        return { type: (action as { type: string }).type, ok: false, detail: "unknown action" };
    }
  } catch (e) {
    return { type: action.type, ok: false, detail: (e as Error).message ?? String(e) };
  }
}

// ── Agent node (Lane 4) ──────────────────────────────────────────────────────
// An `agent` node runs a bounded ReAct-style tool loop: the tenant's hosted model is
// asked to pick ONE action per step (as JSON), we execute it via runAction, feed the
// result back, and repeat until the model says done or maxSteps is reached. Tools are
// the automation action primitives, gated by the node's allow-list. The extractive rule
// baseline has no generative reasoning, so with no hosted model the node no-ops (honest —
// surfaced in the run log), which also keeps FORCE_RULE_MODEL tests free + deterministic.

// Derived from the ONE registry so the agent's tool vocabulary can never drift from the effect
// classification (dogfood L0-F1). Insertion order = registry order (used for the tool-list prompt).
const AGENT_TOOLS: readonly string[] = Object.keys(TOOL_REGISTRY);
const AGENT_MAX_STEPS = 8;

interface AgentConfig {
  instructions?: string;
  tools?: string[];
  maxSteps?: number;
  /** Stop the loop after the first successful reply (default true — item 17). */
  replyThenStop?: boolean;
  /** Per-node/per-run model override (dogfood L0-F2) — swaps the model name within the tenant's
   *  hosted provider/key. No effect for a managed-baseline tenant. */
  model?: string;
}

interface AgentDecision {
  action?: AutomationAction;
  done?: boolean;
  summary?: string;
  reason?: string;
}

// ── Agent-loop hardening (Wave 5 item 17) ────────────────────────────────────
// Per-tool required fields + enum constraints, enforced BEFORE execution. An invalid
// decision is fed back to the model verbatim so it can self-correct (bounded retries)
// instead of the loop silently skipping the step.
const TOOL_REQUIRED: Record<string, string[]> = {
  reply: ["body"],
  set_status: ["status"],
  assign: [], // assigneeId: null is a valid unassign
  notify: ["integrationId", "text"],
  run: ["cmd"],
  http: ["url"],
  rag: [],
  kb_upsert: ["kbTitle", "kbBody"],
  contact_update: [],
  broadcast_send: ["broadcastSubject", "broadcastBody"],
  set_fields: ["setFields"],
  web_fetch: ["url"],
  browser_extract: ["url"],
  set_priority: ["priority"],
  add_tags: ["tags"],
  apply_tag_rules: [],
  ai_tag: [],
  survey: ["surveyKind"],
  escalate: [],
};
const TOOL_ENUMS: Record<string, [field: string, values: string[]]> = {
  set_status: ["status", ["open", "closed"]],
  set_priority: ["priority", ["low", "normal", "high", "urgent"]],
  survey: ["surveyKind", ["csat", "nps", "both"]],
};

/** Validate a model-proposed action against the tool schema. Returns the error message
 *  to feed back to the model, or null when the action is well-formed. */
export function validateAgentAction(act: AutomationAction, allowed: Set<string>): string | null {
  if (!act.type) return `missing "type" — pick one of: ${[...allowed].join(", ")}`;
  if (!allowed.has(act.type)) return `tool "${act.type}" is not available — pick one of: ${[...allowed].join(", ")}`;
  for (const field of TOOL_REQUIRED[act.type] ?? []) {
    const v = (act as Record<string, unknown>)[field];
    const empty = v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
    if (empty) return `"${act.type}" requires a non-empty "${field}"`;
  }
  const en = TOOL_ENUMS[act.type];
  if (en) {
    const v = (act as Record<string, unknown>)[en[0]];
    if (typeof v === "string" && !en[1].includes(v)) {
      return `"${act.type}"."${en[0]}" must be one of: ${en[1].join(" | ")} (got "${v}")`;
    }
  }
  return null;
}

/** Stable fingerprint of an action for the dedupe guard — key order can't defeat it. */
export function actionFingerprint(act: AutomationAction): string {
  const o = act as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** One step of the persisted loop trace (agent_runs.steps). */
export interface AgentStep {
  step: number;
  kind: "action" | "done" | "invalid" | "duplicate" | "error" | "limit";
  tool?: string;
  reason?: string;
  ok?: boolean;
  detail?: string;
}

interface AgentRunMeta {
  source: "manual" | "automation";
  automationId?: string | null;
}

/** Persist one agent-loop run (the ticket-timeline trace). Best-effort — a trace write
 *  failure must never fail the run itself. Returns the run id (or null). */
async function recordAgentRun(
  tenantId: string,
  meta: AgentRunMeta,
  ctx: Ctx,
  config: AgentConfig,
  model: string,
  status: "done" | "error",
  steps: AgentStep[],
  actions: ActionResult[],
  dryRun: boolean,
): Promise<string | null> {
  try {
    return await withTenant(tenantId, async (c) => {
      const r = await c.query(
        `INSERT INTO agent_runs (tenant_id, ticket_id, source, automation_id, dry_run, status, instructions, model, steps, actions)
         VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         RETURNING id`,
        [
          (ctx.ticketId as string) ?? null, meta.source, meta.automationId ?? null, dryRun, status,
          clip(config.instructions ?? "", 2000), model, JSON.stringify(steps),
          JSON.stringify(actions.map((a) => ({ type: a.type, ok: a.ok, detail: clip(a.detail ?? "", 300) }))),
        ],
      );
      return r.rows[0].id as string;
    });
  } catch {
    return null;
  }
}

// Extract the first BALANCED JSON object from a completion (models wrap JSON in prose /
// code fences). String-aware brace matching; returns null when nothing parses.
export function parseAgentDecision(raw: string): AgentDecision | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)) as AgentDecision; } catch { return null; }
      }
    }
  }
  return null;
}

async function agentToolLines(tenantId: string, allowed: Set<string>): Promise<string[]> {
  let assignees = "", integrations = "";
  if (allowed.has("assign")) {
    const rows = await withTenant(tenantId, async (c) =>
      (await c.query("SELECT id, name, email FROM users ORDER BY name LIMIT 25")).rows as Array<{ id: string; name: string; email: string }>,
    );
    assignees = rows.map((u) => `${u.id} — ${u.name || u.email}`).join("; ") || "(none)";
  }
  if (allowed.has("notify")) {
    const rows = await withTenant(tenantId, async (c) =>
      (await c.query("SELECT id, name FROM integrations WHERE enabled ORDER BY name LIMIT 25")).rows as Array<{ id: string; name: string }>,
    );
    integrations = rows.map((i) => `${i.id} — ${i.name}`).join("; ") || "(none)";
  }
  const desc: Record<string, string> = {
    reply: `{"type":"reply","body":"<message to the customer>"} — post an agent reply on the ticket`,
    set_status: `{"type":"set_status","status":"closed"|"open"} — close or reopen the ticket`,
    assign: `{"type":"assign","assigneeId":"<id>|null"} — assign to a teammate. Teammates: ${assignees}`,
    notify: `{"type":"notify","integrationId":"<id>","text":"<alert>"} — alert a connector. Connectors: ${integrations}`,
    run: `{"type":"run","cmd":"<shell command>"} — run a command in the sandboxed runner`,
    http: `{"type":"http","method":"GET","url":"<url>","headers":"<Key: Value lines>","httpBody":"<body>"} — make an HTTP request to a URL`,
    rag: `{"type":"rag","autoReply":false} — draft a grounded answer from the knowledge base`,
    kb_upsert: `{"type":"kb_upsert","kbTitle":"<title>","kbBody":"<article body>"} — create + index a knowledge-base article`,
    contact_update: `{"type":"contact_update","contactEmail":"<email>","contactName":"<name>","contactFields":"<Key: Value lines>"} — upsert a directory contact`,
    broadcast_send: `{"type":"broadcast_send","broadcastSubject":"<subject>","broadcastBody":"<body>"} — compose + send a broadcast to the directory`,
    set_fields: `{"type":"set_fields","setFields":"key: {{expr}}"} — compute/store named values into vars for later steps`,
    web_fetch: `{"type":"web_fetch","url":"<url>"} — fetch a web page and extract its readable text into web.text`,
    browser_extract: `{"type":"browser_extract","url":"<url>"} — render a JS page in a headless browser and extract its text into web.text (use for SPAs web_fetch can't read)`,
    set_priority: `{"type":"set_priority","priority":"low"|"normal"|"high"|"urgent"} — set the ticket's priority`,
    add_tags: `{"type":"add_tags","tags":["<tag>", ...]} — append tags to the ticket`,
    apply_tag_rules: `{"type":"apply_tag_rules"} — apply the workspace keyword tag rules to the ticket`,
    ai_tag: `{"type":"ai_tag"} — classify the ticket with AI and append topic tags`,
    survey: `{"type":"survey","surveyKind":"csat"|"nps"|"both"} — send a satisfaction survey (once per ticket)`,
    escalate: `{"type":"escalate","priority":"urgent","assigneeId":"<id>|null","integrationId":"<id>|null","text":"<alert>"} — escalate: bump priority + optionally reassign + notify a connector`,
  };
  return AGENT_TOOLS.filter((t) => allowed.has(t)).map((t) => `- ${desc[t]}`);
}

/** Total invalid-decision retries the loop tolerates before giving up (across all steps). */
const AGENT_INVALID_RETRIES = 2;

// ---- Test seam: the completion driver the agent loop uses -----------------
// Tests inject a scripted driver so loop mechanics (retry / dedupe / reply-then-stop)
// are checkable without a hosted model (mirrors slack.__setSlackFetch).
interface AgentDriverLike { name?: string; complete?: (system: string, user: string) => Promise<string> }
let agentDriverOverride: AgentDriverLike | null = null;
export function __setAgentDriver(d: AgentDriverLike | null): void {
  agentDriverOverride = d;
}

export async function runAgent(
  tenantId: string,
  config: AgentConfig,
  ctx: Ctx,
  opts: ExecOpts = {},
  meta: AgentRunMeta = { source: "automation" },
): Promise<{ output: unknown; results: ActionResult[] }> {
  // Per-node model selection (dogfood L0-F2): the node/run's chosen model, resolved through the
  // tenant's hosted provider+key. Falls back to the tenant default when unset or on a managed baseline.
  const driver: AgentDriverLike =
    agentDriverOverride ?? (await resolveModelDriver(tenantId, config.model ? { model: config.model } : undefined));
  const executed: ActionResult[] = [];
  const transcript: string[] = [];
  const trace: AgentStep[] = [];

  if (typeof driver.complete !== "function") {
    return { output: { agent: "skipped", reason: "no hosted model (rule baseline has no agentic reasoning)" }, results: [] };
  }

  const allowed = new Set((config.tools?.length ? config.tools : ["reply", "set_status"]).filter((t) => (AGENT_TOOLS as readonly string[]).includes(t)));
  if (allowed.size === 0) allowed.add("reply");
  const maxSteps = Math.min(Math.max(1, config.maxSteps ?? 4), AGENT_MAX_STEPS);
  // Reply-then-stop (default ON): once a reply reaches the customer, the loop ends — an
  // agent that keeps mutating the ticket after answering is how weird states happen.
  const replyThenStop = config.replyThenStop !== false;
  const lines = await agentToolLines(tenantId, allowed);

  const system = [
    "You are an autonomous customer-support automation agent working a single ticket.",
    config.instructions ? `Your goal: ${config.instructions}` : "Your goal: resolve or route the ticket appropriately.",
    "",
    "Each step, take ONE action by replying with a single JSON object; you'll then see the result and can act again or finish.",
    "Available tools:",
    ...lines,
    "",
    "Reply with ONLY one JSON object — no prose, no markdown fences. Either:",
    `  {"action": <one tool object above>, "reason": "<short why>"}`,
    `  {"done": true, "summary": "<what you did>"}`,
    `Use {"done":true} immediately if no action is warranted. Never repeat an action that already succeeded. Be conservative.`,
    replyThenStop ? "After you send a reply to the customer, the run ends — reply LAST." : "",
  ].join("\n");

  // The succeeded-action dedupe guard: prompt asks the model not to repeat itself; this enforces it.
  const succeeded = new Set<string>();
  let status: "done" | "error" = "done";
  let invalidRetries = 0;
  let step = 0;
  // A schema/parse feedback message carried into the NEXT model call (retry channel).
  let feedback: string | null = null;

  while (step < maxSteps) {
    const user = [
      "Ticket context:",
      `- subject: ${clip(String(ctx.subject ?? ""), 200)}`,
      `- latest message: ${clip(String(ctx.body ?? ""), 600)}`,
      `- channel: ${ctx.channelType ?? "?"}  status: ${ctx.status ?? "?"}  whoseTurn: ${ctx.whoseTurn ?? "?"}`,
      transcript.length ? `\nActions so far:\n${transcript.join("\n")}` : "",
      feedback ? `\nYOUR LAST RESPONSE WAS INVALID: ${feedback}\nCorrect it and answer with valid JSON only.` : "",
      "\nDecide the next step (JSON only).",
    ].join("\n");
    feedback = null;

    let raw: string;
    try {
      raw = await driver.complete!(system, user);
    } catch (e) {
      const detail = `model error: ${clip((e as Error).message, 160)}`;
      executed.push({ type: "agent", ok: false, detail });
      trace.push({ step, kind: "error", detail });
      status = "error";
      break;
    }

    const decision = parseAgentDecision(raw);
    // Invalid JSON / invalid action schema → feed the error back and retry (bounded),
    // instead of silently skipping or stopping on a recoverable formatting slip.
    const schemaError = decision
      ? (decision.done || !decision.action ? null : validateAgentAction(decision.action, allowed))
      : "response contained no parseable JSON object";
    if (schemaError) {
      trace.push({ step, kind: "invalid", detail: schemaError });
      if (invalidRetries < AGENT_INVALID_RETRIES) {
        invalidRetries++;
        feedback = schemaError;
        continue; // retry the SAME step — retries don't consume the step budget
      }
      transcript.push(`(invalid response after ${AGENT_INVALID_RETRIES} retries — stopping)`);
      status = "error";
      break;
    }

    if (!decision || decision.done || !decision.action) {
      transcript.push(`done: ${clip(decision?.summary ?? "", 160)}`);
      trace.push({ step, kind: "done", detail: clip(decision?.summary ?? "", 200) });
      break;
    }

    const act = decision.action;
    // Enforced dedupe: an identical already-succeeded action never runs twice.
    const fp = actionFingerprint(act);
    if (succeeded.has(fp)) {
      transcript.push(`skipped duplicate ${act.type} (already succeeded — do something else or finish)`);
      trace.push({ step, kind: "duplicate", tool: act.type });
      step++;
      continue;
    }

    const result = await runAction(tenantId, act, ctx, opts);
    executed.push({ ...result, type: `agent:${result.type}` });
    transcript.push(`${act.type} → ${result.ok ? "ok" : "FAILED"}: ${result.detail}`);
    trace.push({
      step, kind: "action", tool: act.type, reason: clip(decision.reason ?? "", 200),
      ok: result.ok, detail: clip(result.detail ?? "", 300),
    });
    if (result.ok) succeeded.add(fp);

    if (replyThenStop && act.type === "reply" && result.ok) {
      transcript.push("reply delivered — stopping (reply-then-stop)");
      trace.push({ step, kind: "limit", detail: "reply-then-stop" });
      break;
    }
    step++;
  }
  if (step >= maxSteps) trace.push({ step, kind: "limit", detail: `max steps (${maxSteps}) reached` });

  // Persist the loop trace (the ticket-timeline record). Best-effort, after the loop.
  const runId = await recordAgentRun(
    tenantId, { source: meta.source, automationId: meta.automationId ?? opts.automationId ?? null },
    ctx, config, driver.name ?? "hosted", status, trace, executed, opts.dryRun === true,
  );

  return {
    output: { agent: "ran", runId, steps: transcript, actions: executed.map((r) => ({ type: r.type, ok: r.ok })) },
    results: executed,
  };
}

// Interactive agent run — invoke the SAME autonomous loop on demand against one ticket (a
// "resolve this for me" button), instead of only as an event-triggered graph node. Seeds the
// context with the ticket + its latest customer message, then runs runAgent. dryRun (the
// default from the caller) keeps it safe — side-effecting tools report what they *would* do.
export async function runTicketAgent(
  tenantId: string,
  ticketId: string,
  config: AgentConfig,
  opts: ExecOpts = {},
): Promise<{ output: unknown; results: ActionResult[] } | null> {
  const latest = await withTenant(tenantId, async (c) => {
    const t = await c.query("SELECT 1 FROM tickets WHERE id = $1", [ticketId]);
    if (!t.rowCount) return undefined;
    const m = await c.query(
      `SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'customer'
        ORDER BY created_at DESC LIMIT 1`,
      [ticketId],
    );
    return (m.rows[0]?.body as string | undefined) ?? "";
  });
  if (latest === undefined) return null; // ticket not visible
  const ctx = await buildContext(tenantId, "manual", { ticketId, body: latest });
  return runAgent(tenantId, config, ctx, opts, { source: "manual" });
}

// The persisted agent-loop traces for one ticket (the timeline surface), newest first.
export interface AgentRunRow {
  id: string;
  ticket_id: string | null;
  source: string;
  automation_id: string | null;
  dry_run: boolean;
  status: string;
  instructions: string;
  model: string;
  steps: AgentStep[];
  actions: Array<{ type: string; ok: boolean; detail: string }>;
  created_at: string;
}

export async function listAgentRunsForTicket(tenantId: string, ticketId: string): Promise<AgentRunRow[]> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, ticket_id, source, automation_id, dry_run, status, instructions, model, steps, actions, created_at
         FROM agent_runs WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [ticketId],
    );
    return r.rows as AgentRunRow[];
  });
}

// ── Flow-graph execution (Lane 1) ────────────────────────────────────────────
// A rule may carry a `graph` (nodes + edges) instead of a linear action list. runGraph walks it
// in topological order from the trigger node: branch nodes evaluate conditions and activate their
// true/false out-edges, action nodes reuse runAction, and each node's output is threaded into
// ctx.steps so downstream configs can reference {{steps.<id>.<field>}}. Returns the ActionResults
// produced by action nodes (for the run log + chaining). Best-effort on a cyclic graph.

interface GraphNode { id: string; type: string; config: Record<string, unknown> }
interface GraphEdge { from: string; to: string; when?: string }
interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

async function runNode(
  tenantId: string,
  node: GraphNode,
  ctx: Ctx,
  opts: ExecOpts = {},
): Promise<{ output: unknown; result?: ActionResult; results?: ActionResult[]; fired?: "true" | "false" }> {
  switch (node.type) {
    case "trigger":
      return { output: { event: ctx.event } };
    case "branch": {
      const conditions = (node.config?.conditions as AutomationConditions) ?? { match: "all", conditions: [] };
      return { output: { matched: evaluateConditions(conditions, ctx) } };
    }
    case "action": {
      const action = node.config?.action as AutomationAction | undefined;
      if (!action) return { output: { skipped: "no action" } };
      const result = await runAction(tenantId, action, ctx, opts);
      return { output: result, result };
    }
    case "agent": {
      const cfg = (node.config?.agent as AgentConfig) ?? {};
      const out = await runAgent(tenantId, cfg, ctx, opts);
      return { output: out.output, results: out.results };
    }
    case "item": {
      // Studio→Studio fold: a general-purpose item node on the {json,text} data-plane. Its inputs are
      // threaded onto opts by runGraph; ifCond returns `fired` to steer branch-edge activation.
      const kind = String(node.config?.kind ?? "");
      const inputs = ((opts as ExecOpts & { __inputs?: Item[] }).__inputs) ?? [];
      const r = await runItemNode(tenantId, kind, node.config ?? {}, inputs, ctx, opts);
      return { output: { items: r.items }, result: r.result, fired: r.fired };
    }
    default:
      return { output: { skipped: `unknown node ${node.type}` } };
  }
}

// Studio→Studio fold (Phase 3a): map a terminal flow-container run into the ActionResult[] the walk
// would have produced, and replay its per-node trace onto the live SSE. The container writes a
// node_events array ([{nodeId,kind,ok,detail}]) + result_json (the final items) to runner_runs.
function mapFlowRun(term: RunnerRun | null, opts: ExecOpts, skipEmit = false): ActionResult[] {
  if (!term) {
    return [{ type: "flow", ok: false, detail: "flow run did not return (enqueue failed)" }];
  }
  const events = Array.isArray(term.nodeEvents) ? (term.nodeEvents as Array<Record<string, unknown>>) : [];
  const results: ActionResult[] = [];
  for (const ev of events) {
    const nodeId = (ev.nodeId as string | undefined) ?? null;
    const r: ActionResult = {
      type: String(ev.kind ?? ev.type ?? "item"),
      ok: ev.ok !== false && ev.status !== "error",
      detail: String(ev.detail ?? ""),
      nodeId,
    };
    results.push(r);
    // Replay the container's node outcome onto the interactive SSE so the canvas lights up —
    // skipped when the live NATS relay already streamed these (no double flash).
    if (!skipEmit) opts.emit?.({ nodeId, phase: "end", ntype: "item", type: r.type, ok: r.ok, detail: r.detail });
  }
  if (results.length === 0) {
    // No per-node trace (older container / crash before first node): fall back to the run status.
    const ok = term.status === "succeeded";
    results.push({ type: "flow", ok, detail: ok ? "flow run complete" : (term.error ?? `flow run ${term.status}`) });
  }
  return results;
}

export async function runGraph(tenantId: string, graph: Graph, ctx: Ctx, opts: ExecOpts = {}): Promise<ActionResult[]> {
  // Studio→Studio fold (Phase 3a): a graph containing any browser/AI-browser item node can't run in
  // the api process (it needs one persistent Chromium across openUrl→act→extract). Delegate the WHOLE
  // graph to the flow-runner container via the runner, then map its terminal trace back into results.
  // Domain-action nodes are NOT available inside a browser flow in 3a (they need the api's DB context).
  if (needsBrowser(graph)) {
    // A browser flow has no meaningful dry-run — every step IS a side effect (a real container,
    // a real Chromium, real model calls). Refuse cheaply instead of silently spending a run.
    if (opts.dryRun) {
      const results: ActionResult[] = (Array.isArray(graph.nodes) ? graph.nodes : [])
        .filter((n) => n.type === "item")
        .map((n) => ({
          type: String(n.config?.kind ?? "item"),
          ok: true,
          detail: "[dry-run] browser flows execute only for real — use Run",
          nodeId: n.id,
        }));
      for (const r of results) opts.emit?.({ nodeId: r.nodeId ?? null, phase: "end", ntype: "item", type: r.type, ok: true, detail: r.detail });
      return results;
    }
    // automationId (when known) ties the run to its flow for the Studio history drawer.
    const run = await createRun(tenantId, "flow", { mode: "flow", graph, input: seedItem(ctx), ...(opts.automationId ? { automationId: opts.automationId } : {}) });
    // Live relay (weft parity): the container publishes node-start/node-done/agent-step frames to
    // core-NATS run.<id> AS IT EXECUTES — forward them straight onto the interactive SSE so the
    // canvas lights up in real time instead of replaying the whole trace after the terminal row.
    let sawLive = false;
    const stop = subscribeRunProgress(run.id, (ev) => {
      if (ev.type === "frame" && typeof ev.data === "string") {
        // Live browser preview (ported from weft): pass the frame straight onto the SSE.
        opts.emit?.({ nodeId: null, phase: "step", ntype: "frame", type: "frame", frame: ev.data });
        return;
      }
      if (!ev.nodeId) return;
      sawLive = true;
      if (ev.type === "node-start") {
        opts.emit?.({ nodeId: ev.nodeId, phase: "start", ntype: "item", type: ev.kind ?? "item" });
      } else if (ev.type === "node-done") {
        opts.emit?.({ nodeId: ev.nodeId, phase: "end", ntype: "item", type: ev.kind ?? "item", ok: ev.status !== "error", detail: ev.detail ?? "" });
      } else if (ev.type === "agent-step") {
        // The browser agent narrating itself — surfaced as a "step" frame (canvas keeps the node
        // running and shows the latest action/reasoning line).
        const line = [ev.action, ev.reasoning].filter(Boolean).join(" — ").slice(0, 300);
        opts.emit?.({ nodeId: ev.nodeId, phase: "step", ntype: "item", type: "agent-step", ok: ev.ok !== false, detail: line });
      }
    });
    try {
      const term = await awaitRunTerminal(tenantId, run.id, 120_000);
      return mapFlowRun(term, opts, sawLive);
    } finally {
      stop();
    }
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, GraphEdge[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // Kahn topological order; fall back to declared order if the graph is cyclic.
  const order: string[] = [];
  const deg = new Map(indeg);
  const queue = nodes.filter((n) => (deg.get(n.id) ?? 0) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const e of outgoing.get(id) ?? []) {
      deg.set(e.to, (deg.get(e.to) ?? 1) - 1);
      if ((deg.get(e.to) ?? 0) === 0) queue.push(e.to);
    }
  }
  if (order.length < nodes.length) for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);

  ctx.steps = (ctx.steps as Record<string, unknown>) ?? {};
  const activeEdges = new Set<GraphEdge>();
  const results: ActionResult[] = [];
  // Studio→Studio fold: per-edge {json,text} item data-channel threaded along active edges.
  const stepItems = new Map<string, Item[]>();
  const seed: Item[] = [seedItem(ctx)];

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const incoming = edges.filter((e) => e.to === id && byId.has(e.from));
    const reached = node.type === "trigger" || incoming.some((e) => activeEdges.has(e));
    if (!reached) continue; // pruned branch — never runs
    // Feed the item data-plane: concat active upstream outputs, hydrate ctx.text/json/item for
    // templating, and hand the inputs to runNode's item case.
    const activeIn = incoming.filter((e) => activeEdges.has(e)).map((e) => e.from);
    const inputs = inputItemsFor(id, activeIn, stepItems, seed);
    hydrateCtxItem(ctx, inputs[0]);
    (opts as ExecOpts & { __inputs?: Item[] }).__inputs = inputs;
    opts.emit?.({ nodeId: id, phase: "start", ntype: node.type });
    const out = await runNode(tenantId, node, ctx, opts);
    (ctx.steps as Record<string, unknown>)[id] = out.output;
    // Record the node's produced items for downstream nodes. Item nodes emit an items array; action
    // nodes wrap their result; trigger/branch pass the data-plane through.
    const outItems: Item[] =
      node.type === "item"
        ? ((out.output as { items?: Item[] }).items ?? [])
        : node.type === "action"
          ? [{ json: out.result, text: out.result?.detail ?? "" }]
          : inputs;
    stepItems.set(id, outItems);
    // Stamp the node id onto each produced result for the per-node run trace.
    const nodeResults: ActionResult[] = [];
    if (out.result) { out.result.nodeId = node.id; results.push(out.result); nodeResults.push(out.result); }
    if (out.results) for (const rr of out.results) { rr.nodeId = node.id; results.push(rr); nodeResults.push(rr); }
    // Live per-node event: branch/trigger have no ActionResult, so summarise their outcome.
    const nodeOk = nodeResults.length ? nodeResults.every((r) => r.ok) : true;
    const nodeDetail = nodeResults.length
      ? nodeResults.map((r) => r.detail).filter(Boolean).join(" · ")
      : node.type === "branch"
        ? ((out.output as { matched?: boolean }).matched ? "→ yes" : "→ no")
        : "";
    opts.emit?.({ nodeId: id, phase: "end", ntype: node.type, type: nodeResults[0]?.type, ok: nodeOk, detail: nodeDetail });
    if (nodeResults.some((r) => r.stop)) break; // `stop` action node halts the graph walk
    for (const e of outgoing.get(id) ?? []) {
      if (node.type === "branch") {
        const want = (out.output as { matched?: boolean }).matched ? "true" : "false";
        if (!e.when || e.when === want) activeEdges.add(e);
      } else if (node.type === "item" && out.fired != null) {
        // Studio→Studio fold (§6): an item ifCond steers branch-edge activation like a branch node —
        // only the out-edge matching the fired handle fires (a bare edge defaults to the "true" path).
        if ((e.when ?? "true") === out.fired) activeEdges.add(e);
      } else {
        activeEdges.add(e);
      }
    }
  }
  return results;
}


async function logRun(
  tenantId: string,
  automationId: string,
  trigger: string,
  ctx: Ctx,
  status: string,
  results: ActionResult[],
  error: string | null,
): Promise<void> {
  // Per-node trace: which node produced each result (nodeId null for linear rules).
  const trace: RunTraceEntry[] = results.map((r) => ({
    nodeId: r.nodeId ?? null,
    type: r.type,
    ok: r.ok,
    detail: r.detail,
  }));
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO automation_runs (tenant_id, automation_id, trigger_event, status, ticket_id, event, actions_result, trace, error)
       VALUES (current_tenant(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
      [automationId, trigger, status, ctx.ticketId ?? null, JSON.stringify(ctx), JSON.stringify(results), JSON.stringify(trace), error],
    );
    await c.query("UPDATE automations SET run_count = run_count + 1, last_run_at = now() WHERE id = $1", [automationId]);
  });
}

// ── The engine entry point (called fire-and-forget by the hooks) ────────────────

export async function runAutomations(tenantId: string, trigger: string, seed: Ctx, depth = 0): Promise<void> {
  const rules = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      `SELECT id, name, conditions, actions, graph FROM automations WHERE trigger_event = $1 AND enabled ORDER BY created_at ASC`,
      [trigger],
    );
    return r.rows as Array<{ id: string; name: string; conditions: AutomationConditions; actions: AutomationAction[]; graph: FlowGraph | null }>;
  });
  if (rules.length === 0) return;

  const ctx = await buildContext(tenantId, trigger, seed);

  for (const rule of rules) {
    try {
      let results: ActionResult[];
      if (rule.graph && Array.isArray(rule.graph.nodes) && rule.graph.nodes.length > 0) {
        // Graph automation: the trigger/branch nodes own condition routing internally.
        results = await runGraph(tenantId, rule.graph as unknown as Graph, ctx, { automationId: rule.id });
      } else {
        if (!evaluateConditions(rule.conditions, ctx)) continue; // linear non-match → silent
        results = [];
        for (const action of rule.actions ?? []) {
          const r = await runAction(tenantId, action, ctx);
          results.push(r);
          if (r.stop) break; // `stop` halts the rest of THIS rule's actions
        }
      }
      if (results.length === 0) continue; // nothing executed → stay silent (no run row)
      const status = results.every((r) => r.ok) ? "success" : "partial";
      await logRun(tenantId, rule.id, trigger, ctx, status, results, null);
      // Rule chaining: re-fire the domain triggers this rule's successful state changes imply,
      // on a fresh context, bounded by MAX_CHAIN_DEPTH so a cyclic rule set still terminates.
      if (depth < MAX_CHAIN_DEPTH && ctx.ticketId) {
        const downstream = [...new Set(results.filter((r) => r.ok && r.chain).map((r) => r.chain as string))];
        for (const dt of downstream) {
          void runAutomations(tenantId, dt, { ticketId: ctx.ticketId }, depth + 1).catch(() => {});
        }
      }
      // First-match-wins (dogfood L1-C4): a `stop` in this rule's results halts the remaining
      // rules for this trigger — routing seeds end with `stop` so exactly one rule assigns.
      if (results.some((r) => r.stop)) break;
    } catch (e) {
      // One rule failing must not stop the others; record it and move on.
      try {
        await logRun(tenantId, rule.id, trigger, ctx, "error", [], (e as Error).message ?? String(e));
      } catch {
        /* logging is best-effort */
      }
    }
  }
}

/**
 * The single domain-event seam (dogfood L0-F3). Every product mutation raises its trigger through
 * here instead of hand-calling runAutomations, so the trigger vocabulary is ONE typed set and there
 * is one place to later add outbox unification / a durable queue / backpressure. Post-commit,
 * fire-and-forget — never on the synchronous hot path. A trigger no rule listens to is a cheap
 * no-op (runAutomations early-returns on zero matching rules), so new emit points are additive.
 */
export function emitDomainEvent(tenantId: string, event: AutomationTrigger, seed: Ctx = {}): void {
  void runAutomations(tenantId, event, seed).catch(() => {});

  // Discord ops-mirror — a NATIVE listener on the same seam (a first-class feature, not a Studio
  // flow). ticket.created evaluates the per-binding auto-mirror filter (with one delayed re-check
  // so seeded autotag/routing effects are visible); the facet-change events re-evaluate (a ticket
  // that now matches gets mirrored; an already-mirrored one just re-syncs its forum tags);
  // ticket.closed archives the post. Dynamic import breaks the module cycle; failures swallowed.
  const ticketId = typeof seed.ticketId === "string" ? seed.ticketId : null;
  if (ticketId) {
    if (event === "ticket.created" || event === "ticket.priority_changed" || event === "ticket.tagged" || event === "ticket.assigned") {
      void import("./discord-mirror.js")
        .then((m) => m.evaluateAutoMirror(tenantId, ticketId, { recheck: event === "ticket.created" }))
        .catch(() => {});
    } else if (event === "ticket.closed") {
      void import("./discord-mirror.js")
        .then((m) => m.syncMirrorState(tenantId, ticketId))
        .catch(() => {});
    }
  }
}

// ── Schedule trigger (Milestone 2) ───────────────────────────────────────────────
// A minute-tick scheduler (wired in server.ts) fires enabled `schedule` automations whose
// interval has elapsed. Cross-tenant, so it reads the due set on the BYPASSRLS relay pool
// (event_relay has SELECT on automations) BEFORE dropping into each tenant's RLS context via
// runAutomations. Overlap-guarded + never throws out of the interval.

const DEFAULT_SCHEDULE_INTERVAL_MIN = 60;

/** Pure due-check: null lastRun is always due; otherwise due once intervalMinutes (default 60)
 *  have elapsed. Extracted so the scheduling policy is unit-testable without a clock or DB. */
export function isScheduleDue(lastRunAt: string | null, intervalMinutes: number | undefined, now: number): boolean {
  if (!lastRunAt) return true;
  const minutes = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : DEFAULT_SCHEDULE_INTERVAL_MIN;
  return now - new Date(lastRunAt).getTime() >= minutes * 60_000;
}

type SchedulerLog = { error: (...a: unknown[]) => void };

let scheduleRunning = false;

/** Fire every enabled `schedule` automation whose interval has elapsed. Deduped to one
 *  runAutomations call per tenant with a due rule (runAutomations already loads all of that
 *  tenant's schedule rules). Defensive: per-tenant try/catch, module-level overlap flag, and it
 *  never throws so the setInterval can't die. */
export async function runScheduledAutomations(log?: SchedulerLog): Promise<void> {
  if (scheduleRunning) return; // previous tick still in flight → skip
  scheduleRunning = true;
  try {
    const rows = await relayPool.query(
      "SELECT tenant_id, trigger_config, last_run_at FROM automations WHERE trigger_event = 'schedule' AND enabled",
    );
    const now = Date.now();
    const dueTenants = new Set<string>();
    for (const row of rows.rows) {
      const cfg = (row.trigger_config as { intervalMinutes?: number } | null) ?? null;
      const lastRunAt = row.last_run_at ? new Date(row.last_run_at as string).toISOString() : null;
      if (isScheduleDue(lastRunAt, cfg?.intervalMinutes, now)) dueTenants.add(row.tenant_id as string);
    }
    for (const tenantId of dueTenants) {
      try {
        await runAutomations(tenantId, "schedule", {}); // minimal seed, no ticketId
      } catch (e) {
        log?.error({ err: e }, "scheduled automation run failed");
      }
    }
  } catch (e) {
    log?.error?.({ err: e }, "schedule scheduler tick failed");
  } finally {
    scheduleRunning = false;
  }
}

// ── Interactive execution (the Studio canvas "Run") ──────────────────────────────
// Actually walks the flow graph for a single automation against a caller-supplied sample
// context, streaming per-node events (opts.emit) so the canvas lights up live. dryRun (the
// default from the canvas) suppresses side-effecting actions; a real run persists to the run
// history and, for `run` nodes, blocks on the runner's terminal output. Distinct from
// runAutomationTest (pure dry evaluation, no graph walk) and runAutomations (the fire-and-
// forget engine entry the hooks call across ALL rules for a trigger).
export interface ExecuteResult {
  status: "success" | "partial" | "error";
  matched: boolean;
  trace: RunTraceEntry[];
  error: string | null;
}

export async function executeAutomation(
  tenantId: string,
  id: string,
  context: Record<string, unknown>,
  opts: ExecOpts = {},
): Promise<ExecuteResult | null> {
  const rule = await getAutomation(tenantId, id);
  if (!rule) return null;
  const graph =
    rule.graph && Array.isArray(rule.graph.nodes) && rule.graph.nodes.length > 0
      ? (rule.graph as unknown as Graph)
      : null;
  const ctx = await buildContext(tenantId, rule.trigger, { ...context });

  let results: ActionResult[] = [];
  let status: "success" | "partial" | "error" = "success";
  let error: string | null = null;
  let matched = true;
  try {
    if (graph) {
      results = await runGraph(tenantId, graph, ctx, opts);
    } else {
      // Legacy linear rule (no canvas graph): evaluate conditions then run actions in order.
      matched = evaluateConditions(rule.conditions, ctx);
      if (matched) {
        for (const action of rule.actions ?? []) {
          opts.emit?.({ nodeId: null, phase: "start", ntype: "action" });
          const r = await runAction(tenantId, action, ctx, opts);
          results.push(r);
          opts.emit?.({ nodeId: null, phase: "end", ntype: "action", type: r.type, ok: r.ok, detail: r.detail });
        }
      }
    }
    status = results.length === 0 || results.every((r) => r.ok) ? "success" : "partial";
  } catch (e) {
    status = "error";
    error = (e as Error).message ?? String(e);
  }

  const trace: RunTraceEntry[] = results.map((r) => ({
    nodeId: r.nodeId ?? null,
    type: r.type,
    ok: r.ok,
    detail: r.detail,
  }));

  // A real (non-dry) interactive run is a genuine execution → persist it to the run history.
  if (!opts.dryRun) {
    try { await logRun(tenantId, id, "manual", ctx, status, results, error); } catch { /* best-effort */ }
  }
  return { status, matched, trace, error };
}

// ── Dry-run (the builder's "Test" button) ───────────────────────────────────────

export interface AutomationTestResult {
  matched: boolean;
  trigger: string;
  plan: Array<{ type: string; summary: string }>;
}

/** Evaluate a rule's conditions against a caller-supplied context and return the action plan
 *  WITHOUT executing anything. */
export async function runAutomationTest(
  tenantId: string,
  id: string,
  context: Record<string, unknown>,
): Promise<AutomationTestResult | null> {
  const rule = await getAutomation(tenantId, id);
  if (!rule) return null;
  const ctx: Ctx = { event: rule.trigger, ...context };
  const matched = evaluateConditions(rule.conditions, ctx);
  const plan = (rule.actions ?? []).map((a) => ({
    type: a.type,
    summary:
      a.type === "assign"
        ? `assign → ${a.assigneeId ?? "unassigned"}`
        : a.type === "set_status"
          ? `set status → ${a.status ?? "closed"}`
          : a.type === "reply"
            ? `reply: ${interpolate(a.body ?? "", ctx).slice(0, 80)}`
            : a.type === "notify"
              ? `notify via integration ${a.integrationId ?? "?"}: ${interpolate(a.text ?? "", ctx).slice(0, 80)}`
              : a.type === "run"
                ? `run: ${interpolate(a.cmd ?? "", ctx).slice(0, 80)}`
                : "unknown",
  }));
  return { matched, trigger: rule.trigger, plan };
}
