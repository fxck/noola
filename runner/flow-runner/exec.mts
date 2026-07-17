// ── Noola flow-runner containerized executor (Studio→Studio fold, Phase 3a) ────
// Runs ONE Studio automation graph to completion inside an ephemeral container, driving a local
// headless Chromium with a Claude agent (Stagehand v3). Launched by the Go runner worker via
// `docker run --rm --network=host` (one container per flow job), so every run is a fresh, bounded,
// self-cleaning sandbox. Progress is published to NATS `run.<RUN_ID>` (relayed to the canvas SSE in
// a later phase); the authoritative structured output — produced items (result_json) + a per-node
// trace (node_events) — is written back to the shared `runner_runs` row this run belongs to.
//
// This mirrors the api's in-process item semantics (automations/items.ts) inline rather than
// importing that module, because items.ts transitively pulls the api's DB/conditions layer into the
// image. The browser/AI kinds are container-only regardless, so the shared surface is just the small
// deterministic item bodies (http/code/transform) — kept faithful to items.ts here.
//
// Graph shape is Studio's: { nodes: [{ id, type, config }], edges: [{ from, to, when }] }. Item nodes
// are `type:"item"` with `config.kind`; the entry is `type:"trigger"`. Domain action/agent/branch
// nodes are NOT executed here in 3a (they need the api's tenant/DB context) — they're skipped.
//
// Env: RUN_ID, TENANT_ID, GRAPH (JSON), INPUT (seed item JSON), ANTHROPIC_API_KEY, NATS_*, DB_*.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import { z } from "zod";
import { connect, StringCodec, type NatsConnection } from "nats";
import pg from "pg";
// The item data-plane + deterministic node library + shared helpers live in @repo/flow-core (the
// SAME implementation the api runs in-process). esbuild inlines it into this container bundle. Only
// the browser + AI-browser nodes below are container-only; everything deterministic is delegated.
import {
  type Item,
  runItemNode as coreRunItemNode,
  interpolate,
  hydrateCtxItem,
  assertPublicUrl,
  withTimeout,
  redactSecrets as redact,
  FLOW_BROWSER_KINDS,
  FLOW_DETERMINISTIC_ITEM_KINDS,
} from "@repo/flow-core";

const RUN_ID = process.env.RUN_ID ?? "";
const TENANT_ID = process.env.TENANT_ID ?? "";
const sc = StringCodec();
const log = (...a: unknown[]) => console.log(`[flow-exec ${RUN_ID.slice(0, 8) || "????????"}]`, ...a);

type Ctx = Record<string, unknown> & { vars: Record<string, unknown> };
interface GNode { id: string; type: string; config: Record<string, unknown> }
interface GEdge { from: string; to: string; when?: string }
interface Graph { nodes: GNode[]; edges: GEdge[] }
interface NodeEvent { nodeId: string; kind: string; status: "ok" | "error"; ok: boolean; detail: string; ms: number }

// Friendly model labels → Stagehand/Anthropic model ids (matches the app's model registry).
const MODEL_IDS: Record<string, string> = {
  "Sonnet 5": "anthropic/claude-sonnet-5",
  "Sonnet 4.6": "anthropic/claude-sonnet-4-6",
  "Opus 4.8": "anthropic/claude-opus-4-8",
  "Haiku 4.5": "anthropic/claude-haiku-4-5-20251001",
};
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

function parseGraph(): Graph {
  let g: unknown;
  try { g = JSON.parse(process.env.GRAPH || "{}"); } catch { g = null; }
  const gg = g as Partial<Graph> | null;
  if (!gg || !Array.isArray(gg.nodes)) return { nodes: [], edges: [] };
  return { nodes: gg.nodes, edges: Array.isArray(gg.edges) ? gg.edges : [] };
}

function seedItems(): Item[] {
  // INPUT is the seed item {json,text} the api built from ctx. Absent → empty item.
  try {
    if (process.env.INPUT) {
      const parsed = JSON.parse(process.env.INPUT) as Partial<Item>;
      if (parsed && typeof parsed === "object" && ("json" in parsed || "text" in parsed)) {
        return [{ json: parsed.json ?? {}, text: String(parsed.text ?? "") }];
      }
      return [{ json: parsed, text: "" }];
    }
  } catch { /* fall through */ }
  return [{ json: {}, text: "" }];
}

async function main(): Promise<void> {
  if (!RUN_ID) { console.error("[flow-exec] RUN_ID missing — nothing to run"); process.exit(1); }
  if (!process.env.NATS_HOST) { console.error("[flow-exec] NATS_HOST missing — cannot publish progress"); process.exit(1); }

  const graph = parseGraph();
  const seed = seedItems();
  const needsBrowser = graph.nodes.some((n) => n.type === "item" && FLOW_BROWSER_KINDS.has(String(n.config?.kind ?? "")));

  // NATS progress channel.
  let nc: NatsConnection | null = null;
  try {
    nc = await connect({
      servers: `${process.env.NATS_HOST}:${process.env.NATS_PORT}`,
      user: process.env.NATS_USER,
      pass: process.env.NATS_PASS,
      name: `flow-exec-${RUN_ID.slice(0, 8)}`,
    });
  } catch (e) {
    log("NATS connect failed (progress disabled):", e instanceof Error ? e.message : e);
  }
  const subject = `run.${RUN_ID}`;
  const publish = (e: Record<string, unknown>): void => {
    try { nc?.publish(subject, sc.encode(JSON.stringify(e))); } catch { /* keep running */ }
  };
  log("publishing progress to", subject, needsBrowser ? "· browser" : "· no browser");

  // Postgres — same DB_* env the worker uses (a BYPASSRLS super role), so we can write this
  // tenant's runner_runs row directly. Degrade gracefully if unreachable.
  const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    max: 2,
  });

  const events: NodeEvent[] = [];
  const outputs: Record<string, { items: Item[] }> = {};
  let lastItems: Item[] = seed;
  let firstError: { nodeId: string; message: string } | null = null;
  let failedCount = 0;

  // Ambient ctx — seeded from the seed item's json (so {{subject}}/{{json.x}} resolve), with a vars
  // sub-store. Hydrated to each node's input item before running it.
  const seedJson = seed[0]?.json;
  const ctx: Ctx = { ...(seedJson && typeof seedJson === "object" ? (seedJson as Record<string, unknown>) : {}), vars: {} };

  let lastPersist = 0;
  const persist = async (final = false): Promise<void> => {
    const now = Date.now();
    if (!final && now - lastPersist < 1500) return;
    lastPersist = now;
    try {
      await pool.query(
        "UPDATE runner_runs SET result_json=$3::jsonb, node_events=$4::jsonb WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, RUN_ID, JSON.stringify({ items: lastItems }), JSON.stringify(events)],
      );
    } catch (e) {
      log("persist failed:", e instanceof Error ? e.message : e);
    }
  };

  // Anthropic key injected by the worker (resolved from the tenant's integrations at the exec host).
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const stagehand = new Stagehand({
    env: "LOCAL",
    experimental: true,
    disableAPI: true,
    model: { modelName: DEFAULT_MODEL, apiKey },
    localBrowserLaunchOptions: {
      headless: true,
      executablePath: chromium.executablePath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
    verbose: 0,
  } as ConstructorParameters<typeof Stagehand>[0]);

  let page: Awaited<ReturnType<typeof stagehand.context.pages>>[number] | null = null;
  let browserReady = false;

  // Live preview + replay spool (ported from weft's recorder): a throttled ~1.4fps JPEG
  // stream published as `frame` events on the run channel, with every shot ALSO spooled to
  // disk — on finalize, ffmpeg encodes the spool into a scrubbable .webm that uploads to
  // object storage and lands on runner_runs.replay_key. Overlap-guarded (a slow screenshot
  // skips ticks rather than queueing); the publish is size-capped under NATS's payload limit,
  // the spool is not (the encoder happily eats big frames).
  const REPLAY_DIR = "/tmp/replay";
  const REPLAY_FPS = 1 / 0.7; // one frame per 700ms tick
  let frameIdx = 0;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  const startFrames = (): void => {
    let busy = false;
    void mkdir(REPLAY_DIR, { recursive: true }).catch(() => {});
    frameTimer = setInterval(() => {
      if (busy || !page) return;
      busy = true;
      page
        .screenshot({ type: "jpeg", quality: 55 })
        .then(async (buf) => {
          if (buf.length < 900_000) publish({ type: "frame", data: buf.toString("base64") });
          await writeFile(`${REPLAY_DIR}/f${String(++frameIdx).padStart(6, "0")}.jpg`, buf).catch(() => {});
        })
        .catch(() => { /* mid-navigation — skip this tick */ })
        .finally(() => { busy = false; });
    }, 700);
  };
  const stopFrames = (): void => {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
  };

  // Encode the frame spool → webm → object storage → replay_key. Best-effort throughout: a
  // missing ffmpeg/storage config or a failed upload yields no replay, never a failed run.
  // The container is ephemeral, so no cleanup needed — it dies with the filesystem.
  const finalizeReplay = async (): Promise<void> => {
    if (frameIdx === 0) return;
    if (!process.env.STORAGE_ENDPOINT || !process.env.STORAGE_BUCKET) return;
    const out = `${REPLAY_DIR}/out.webm`;
    const encoded = await new Promise<boolean>((resolve) => {
      const ff = spawn(
        "ffmpeg",
        ["-y", "-framerate", REPLAY_FPS.toFixed(2), "-i", `${REPLAY_DIR}/f%06d.jpg`,
          "-c:v", "libvpx", "-b:v", "1200k", "-pix_fmt", "yuv420p", out],
        { stdio: "ignore" },
      );
      ff.on("error", () => resolve(false));
      ff.on("close", (code) => resolve(code === 0));
    });
    if (!encoded) { log("replay: ffmpeg encode failed — skipped"); return; }
    const body = await readFile(out);
    const key = `runs/${TENANT_ID}/${RUN_ID}.webm`;
    const s3 = new S3Client({
      region: process.env.STORAGE_REGION ?? "us-east-1",
      endpoint: process.env.STORAGE_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? "",
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? "",
      },
    });
    await s3.send(new PutObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: key, Body: body, ContentType: "video/webm" }));
    await pool.query("UPDATE runner_runs SET replay_key=$3 WHERE tenant_id=$1 AND id=$2", [TENANT_ID, RUN_ID, key]);
    log("replay uploaded:", key, `${body.length}b`, `${frameIdx} frames`);
  };

  // ── Edge-following interpreter (Studio graph shape) ─────────────────────────
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, GEdge[]>();
  const edgesByTarget = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    edgesBySource.set(e.from, [...(edgesBySource.get(e.from) ?? []), e]);
    edgesByTarget.set(e.to, [...(edgesByTarget.get(e.to) ?? []), e.from]);
  }
  const reachableFrom = (starts: string[], exclude: string): Set<string> => {
    const seen = new Set<string>();
    const q = starts.filter((id) => id !== exclude);
    while (q.length) {
      const n = q.shift() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const e of edgesBySource.get(n) ?? []) if (!seen.has(e.to)) q.push(e.to);
    }
    return seen;
  };
  const inputItemsFor = (nodeId: string): Item[] => {
    const srcs = edgesByTarget.get(nodeId) ?? [];
    const collected: Item[] = [];
    for (const s of srcs) if (outputs[s]) collected.push(...outputs[s].items);
    return collected.length ? collected : lastItems;
  };

  const startNode = graph.nodes.find((n) => n.type === "trigger") ?? graph.nodes[0];
  const visited = new Set<string>();
  const frontier: string[] = startNode ? [startNode.id] : [];

  const runOneNode = async (node: GNode): Promise<"true" | "false" | "next" | null> => {
    const kind = node.type === "item" ? String(node.config?.kind ?? "") : node.type;
    const config = node.config ?? {};
    const inItems = inputItemsFor(node.id);
    hydrateCtxItem(ctx, inItems[0]);
    const rs = (s: unknown): string => interpolate(String(s ?? ""), ctx);
    publish({ type: "node-start", nodeId: node.id, kind });
    const t0 = Date.now();
    try {
      let detail = "";
      let fired: "true" | "false" | "next" = "next";
      let producedItems: Item[] | null = null;

      if (FLOW_DETERMINISTIC_ITEM_KINDS.has(kind)) {
        // Deterministic item nodes (httpRequest/setVar/setFields/filter/merge/aggregate/ifCond/code)
        // run identically here and in the api — delegate to the shared @repo/flow-core executor.
        // flow-core reports failures as {ok:false}; the container convention records them as an error
        // node event, so a failed result is surfaced by throwing into the outer catch.
        const r = await coreRunItemNode(kind, config, inItems, ctx);
        if (!r.result.ok) throw new Error(r.result.detail);
        producedItems = r.items;
        detail = r.result.detail;
        if (r.fired) fired = r.fired;
      } else {
        switch (kind) {
        case "trigger":
        case "manualTrigger":
        case "webhookTrigger":
        case "scheduleTrigger":
          producedItems = inItems.length ? inItems : seed;
          detail = "run started";
          break;

        // ── Browser navigation (Playwright page.*) ──
        case "openUrl": {
          const url = rs(config.url);
          if (!url) throw new Error("no URL set");
          assertPublicUrl(url);
          await withTimeout(page!.goto(url, { waitUntil: "domcontentloaded" }), 45_000, "open url");
          detail = url;
          break;
        }
        case "navBack":
          await withTimeout(page!.goBack({ waitUntil: "domcontentloaded" }), 30_000, "go back");
          detail = page!.url();
          break;
        case "navForward":
          await withTimeout(page!.goForward({ waitUntil: "domcontentloaded" }), 30_000, "go forward");
          detail = page!.url();
          break;
        case "reload":
          await withTimeout(page!.reload({ waitUntil: "domcontentloaded" }), 30_000, "reload");
          detail = page!.url();
          break;
        case "waitFor": {
          const sel = rs(config.selector);
          if (sel) {
            await withTimeout(page!.waitForSelector(sel, { timeout: 20_000 }), 22_000, "wait for selector");
            detail = `found ${sel}`;
          } else {
            const ms = Math.min(Number(config.ms) || 1000, 30_000);
            await page!.waitForTimeout(ms);
            detail = `waited ${ms}ms`;
          }
          break;
        }
        case "clickSelector": {
          const sel = rs(config.selector);
          if (!sel) throw new Error("no selector set");
          await withTimeout(page!.click(sel, { timeout: 15_000 }), 17_000, "click");
          detail = sel;
          break;
        }
        case "typeText": {
          const sel = rs(config.selector);
          if (!sel) throw new Error("no selector set");
          const text = rs(config.text);
          await withTimeout(page!.fill(sel, text), 15_000, "type");
          detail = `${sel} ← ${text.slice(0, 40)}`;
          break;
        }
        case "selectOption": {
          const sel = rs(config.selector);
          if (!sel) throw new Error("no selector set");
          const v = rs(config.value);
          const ok = await withTimeout(
            page!.evaluate(
              (a: { sel: string; val: string }) => {
                const el = document.querySelector(a.sel) as HTMLSelectElement | null;
                if (!el) return false;
                const opts = Array.from(el.options);
                const hit = opts.find((o) => o.value === a.val) || opts.find((o) => (o.textContent || "").trim() === a.val);
                el.value = hit ? hit.value : a.val;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
              },
              { sel, val: v },
            ),
            15_000, "select option",
          );
          if (!ok) throw new Error(`no element for ${sel}`);
          detail = `${sel} = ${v}`;
          break;
        }
        case "hover": {
          const sel = rs(config.selector);
          if (!sel) throw new Error("no selector set");
          await withTimeout(
            page!.evaluate((s: string) => {
              const el = document.querySelector(s);
              if (el) el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            }, sel),
            15_000, "hover",
          );
          detail = sel;
          break;
        }
        case "scroll": {
          const amt = Number(config.amount) || 800;
          const dy = config.direction === "up" ? -amt : amt;
          await page!.evaluate((y: number) => window.scrollBy(0, y), dy);
          detail = `${config.direction || "down"} ${Math.abs(dy)}px`;
          break;
        }
        case "pressKey":
          await page!.keyboard.press(String(config.key || "Enter"));
          detail = String(config.key || "Enter");
          break;
        case "getText": {
          const sel = rs(config.selector);
          if (!sel) throw new Error("no selector set");
          const t = await withTimeout(
            page!.evaluate((s: string) => { const el = document.querySelector(s); return el ? (el.textContent || "").trim() : ""; }, sel),
            15_000, "get text",
          );
          const value = t || "";
          const name = String(config.saveAs ?? "").trim();
          if (name) ctx.vars[name] = value;
          producedItems = [{ json: name ? { [name]: value } : { value }, text: value }];
          detail = value ? value.slice(0, 80) : "(empty)";
          break;
        }
        case "screenshot": {
          const buf = await page!.screenshot({ type: "jpeg", quality: 70 });
          detail = `captured (${Math.round(buf.length / 1024)}KB)`;
          break;
        }

        // ── AI-browser (Stagehand + Claude) ──
        case "act": {
          const action = rs(config.action);
          await withTimeout(stagehand.act(action), 90_000, "act");
          detail = action;
          break;
        }
        case "observe": {
          const obs = await withTimeout(stagehand.observe(rs(config.instruction)), 60_000, "observe");
          const list = Array.isArray(obs) ? obs : [];
          const name = String(config.saveAs ?? "").trim();
          if (name) ctx.vars[name] = JSON.stringify(list);
          producedItems = list.length
            ? list.map((o: Record<string, unknown>) => ({ json: o, text: String(o?.description ?? "") }))
            : [{ json: { count: 0 }, text: "" }];
          detail = `${list.length} candidate(s)` + (list[0]?.description ? ` · ${String(list[0].description)}` : "");
          break;
        }
        case "extract": {
          const instruction = rs(config.instruction);
          const data = await withTimeout(
            stagehand.extract(instruction, z.object({ value: z.string().describe(instruction) })),
            60_000, "extract",
          );
          let value = data?.value ? String(data.value) : "";
          const wantsUrl = /\b(link|url)\b/i.test(instruction);
          if (wantsUrl && !/^https?:\/\//.test(value)) { const u = page!.url(); if (/^https?:\/\//.test(u)) value = u; }
          const name = String(config.saveAs ?? "").trim();
          if (name) ctx.vars[name] = value;
          producedItems = [{ json: name ? { [name]: value } : { value }, text: value }];
          detail = value || "(nothing extracted)";
          break;
        }
        case "agent": {
          const agent = stagehand.agent({ model: MODEL_IDS[String(config.model)] || DEFAULT_MODEL });
          let stepN = 0;
          const result = await withTimeout(
            agent.execute({
              instruction: rs(config.instruction),
              maxSteps: 14,
              callbacks: {
                onEvidence: (ev: Record<string, unknown>) => {
                  if (ev.type === "step_finished") {
                    publish({
                      type: "agent-step", nodeId: node.id, n: ++stepN,
                      action: ev.actionName,
                      reasoning: typeof ev.reasoning === "string" ? ev.reasoning.slice(0, 280) : "",
                      ok: (ev.toolOutput as { ok?: boolean } | undefined)?.ok !== false,
                    });
                  } else if (ev.type === "final_answer") {
                    publish({
                      type: "agent-step", nodeId: node.id, n: ++stepN, action: "done",
                      reasoning: typeof ev.message === "string" ? ev.message.slice(0, 280) : "", ok: true,
                    });
                  }
                },
              },
            } as Parameters<ReturnType<typeof stagehand.agent>["execute"]>[0]),
            180_000, "agent",
          );
          const answer = result?.message ? String(result.message).trim() : "";
          const name = String(config.saveAs ?? "").trim();
          if (name && answer) ctx.vars[name] = answer;
          if (answer) producedItems = [{ json: { message: answer }, text: answer }];
          detail = answer ? answer.slice(0, 200) : "completed";
          break;
        }

        default:
          // Domain action/agent/branch nodes are not available inside a browser flow in 3a — skip
          // them, passing the data-plane through so the browser subgraph still completes.
          producedItems = inItems;
          detail = `skipped (not available in browser flow): ${kind}`;
          break;
        }
      }

      const items = producedItems ?? inItems;
      outputs[node.id] = { items };
      lastItems = items;
      events.push({ nodeId: node.id, kind, status: "ok", ok: true, detail, ms: Date.now() - t0 });
      publish({ type: "node-done", nodeId: node.id, status: "ok", ms: Date.now() - t0, detail, nodeOutput: { items } });
      await persist();
      return fired;
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      failedCount++;
      if (!firstError) firstError = { nodeId: node.id, message };
      events.push({ nodeId: node.id, kind, status: "error", ok: false, detail: message, ms: Date.now() - t0 });
      publish({ type: "node-done", nodeId: node.id, status: "error", ms: Date.now() - t0, detail: message });
      await persist();
      // Best-effort: keep walking the rest of the graph (continue on failure).
      return "next";
    }
  };

  let status: "ok" | "partial" | "error" = "ok";
  const t0run = Date.now();
  try {
    if (needsBrowser) {
      if (!apiKey && graph.nodes.some((n) => n.type === "item" && ["act", "observe", "agent", "extract"].includes(String(n.config?.kind ?? "")))) {
        throw new Error("No Anthropic API key — add an anthropic integration for this tenant");
      }
      await withTimeout(stagehand.init(), 60_000, "browser init");
      browserReady = true;
      page = stagehand.context.pages()[0];
      startFrames();
    }

    while (frontier.length) {
      const nodeId = frontier.shift() as string;
      if (visited.has(nodeId)) continue;
      // Join barrier: defer a multi-input node until every still-reachable upstream has run.
      const srcs = edgesByTarget.get(nodeId) ?? [];
      if (srcs.length > 1 && srcs.some((s) => !visited.has(s))) {
        const reach = reachableFrom(frontier, nodeId);
        if (srcs.some((s) => !visited.has(s) && reach.has(s))) { frontier.push(nodeId); continue; }
      }
      visited.add(nodeId);
      const node = byId.get(nodeId);
      if (!node) continue;
      const fired = await runOneNode(node);
      if (fired == null) continue;
      for (const e of edgesBySource.get(nodeId) ?? []) {
        // ifCond steers on the fired handle (true/false); everything else ("next") fires all edges,
        // mirroring the api's runGraph branch-activation semantics.
        if (fired === "true" || fired === "false") {
          if ((e.when ?? "true") === fired) frontier.push(e.to);
        } else {
          frontier.push(e.to);
        }
      }
    }
    if (failedCount > 0) status = "partial";
  } catch (err) {
    status = "error";
    if (!firstError) firstError = { nodeId: "", message: redact(err instanceof Error ? err.message : String(err)) };
    publish({ type: "error", message: firstError.message });
  } finally {
    await persist(true);
    // Record the run's own error on the row (status is owned by the Go worker's markResult).
    if (firstError) {
      try {
        await pool.query(
          "UPDATE runner_runs SET error=COALESCE(error, $3) WHERE tenant_id=$1 AND id=$2",
          [TENANT_ID, RUN_ID, firstError.message],
        );
      } catch { /* best-effort */ }
    }
    stopFrames();
    publish({ type: "run-done", status, failedCount, failedNodeId: firstError ? firstError.nodeId : null, durationMs: Date.now() - t0run });
    // Replay AFTER run-done so the canvas gets its terminal event promptly; the worker only
    // writes the terminal row once the container exits, so replay_key is set by then.
    try { await withTimeout(finalizeReplay(), 45_000, "replay finalize"); } catch (e) { log("replay skipped:", e instanceof Error ? e.message : String(e)); }
    try { if (browserReady) await stagehand.close(); } catch { /* ignore */ }
    try { await pool.end(); } catch { /* ignore */ }
    try { await nc?.drain(); } catch { /* ignore */ }
    log("done — status", status);
    // Exit non-zero on a hard error so the worker marks the run failed; partials exit 0 (per-node
    // trace carries the failures) so a mostly-successful browser flow still surfaces its items.
    process.exit(status === "error" ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("[flow-exec] fatal", e);
  process.exit(1);
});
