import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Combobox } from "@/components/ui/combobox";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Braces } from "lucide-react";

// The item-node library ported from studio (Studio→Studio fold, Phase 4). These are the general
// automation nodes — HTTP, data transforms, a JS sandbox, and browser/AI-browser steps — that sit
// on the SAME canvas as Studio's support-domain actions and flow a {json,text} item along edges.
// This module owns the client taxonomy, the per-kind inspector forms, and the {{…}} VarPicker;
// item nodes serialize as { type: "item", config: { kind, …params } } and ride flow_docs, so
// multiplayer + the live-exec SSE work unchanged. Field NAMES here MUST match the executor
// (api/packages/flow-core + runner/flow-runner/exec.mts) — they read config.url/.selector/.op/… .

export type FlowItemKind =
  | "httpRequest" | "setVar" | "code" | "setFields" | "filter" | "merge" | "aggregate" | "ifCond"
  | "openUrl" | "navBack" | "navForward" | "reload" | "waitFor"
  | "clickSelector" | "typeText" | "selectOption" | "hover" | "scroll" | "pressKey" | "getText" | "screenshot"
  | "act" | "observe" | "extract" | "agent";

export type ItemGroup = "Data & code" | "Browser" | "AI browser";

export interface ItemKindMeta {
  kind: FlowItemKind;
  label: string;
  desc: string;
  group: ItemGroup;
  /** Runs in the flow-runner container (Playwright/Stagehand), not the api process. */
  browser: boolean;
}

// Declaration order = palette order within each group.
export const ITEM_KINDS: ItemKindMeta[] = [
  { kind: "httpRequest", label: "HTTP request", desc: "Call any URL; body flows on", group: "Data & code", browser: false },
  { kind: "setVar", label: "Set variable", desc: "Store a value as vars.<name>", group: "Data & code", browser: false },
  { kind: "setFields", label: "Edit fields", desc: "Merge/replace JSON onto the item", group: "Data & code", browser: false },
  { kind: "filter", label: "Filter", desc: "Keep items matching a rule", group: "Data & code", browser: false },
  { kind: "merge", label: "Merge", desc: "Combine inputs into one stream", group: "Data & code", browser: false },
  { kind: "aggregate", label: "Aggregate", desc: "Reduce many items to one", group: "Data & code", browser: false },
  { kind: "ifCond", label: "If", desc: "Route yes / no on a value", group: "Data & code", browser: false },
  { kind: "code", label: "Code", desc: "Transform items in a JS sandbox", group: "Data & code", browser: false },

  { kind: "openUrl", label: "Open URL", desc: "Navigate a headless browser", group: "Browser", browser: true },
  { kind: "waitFor", label: "Wait for", desc: "Await a selector or a delay", group: "Browser", browser: true },
  { kind: "clickSelector", label: "Click", desc: "Click an element", group: "Browser", browser: true },
  { kind: "typeText", label: "Type", desc: "Type into an input", group: "Browser", browser: true },
  { kind: "selectOption", label: "Select option", desc: "Choose a dropdown value", group: "Browser", browser: true },
  { kind: "hover", label: "Hover", desc: "Hover an element", group: "Browser", browser: true },
  { kind: "scroll", label: "Scroll", desc: "Scroll the page", group: "Browser", browser: true },
  { kind: "pressKey", label: "Press key", desc: "Send a keyboard key", group: "Browser", browser: true },
  { kind: "getText", label: "Get text", desc: "Read an element's text", group: "Browser", browser: true },
  { kind: "screenshot", label: "Screenshot", desc: "Capture the page", group: "Browser", browser: true },
  { kind: "navBack", label: "Back", desc: "Browser history back", group: "Browser", browser: true },
  { kind: "navForward", label: "Forward", desc: "Browser history forward", group: "Browser", browser: true },
  { kind: "reload", label: "Reload", desc: "Reload the page", group: "Browser", browser: true },

  { kind: "act", label: "Act (AI)", desc: "Do it — natural-language action", group: "AI browser", browser: true },
  { kind: "observe", label: "Observe (AI)", desc: "Find elements by description", group: "AI browser", browser: true },
  { kind: "extract", label: "Extract (AI)", desc: "Pull structured data out", group: "AI browser", browser: true },
  { kind: "agent", label: "Browser agent (AI)", desc: "Let a model browse in a loop", group: "AI browser", browser: true },
];

const META = Object.fromEntries(ITEM_KINDS.map((m) => [m.kind, m])) as Record<FlowItemKind, ItemKindMeta>;

export function isItemKind(kind: string): kind is FlowItemKind {
  return kind in META;
}
export function itemKindMeta(kind: string): ItemKindMeta | undefined {
  return META[kind as FlowItemKind];
}
export function itemKindLabel(kind: string): string {
  return META[kind as FlowItemKind]?.label ?? kind;
}
/** ifCond is the only item node that forks — it activates a true/false out-edge, so the canvas
 *  draws it with yes/no handles like a Branch. */
export function isItemBranch(kind: string): boolean {
  return kind === "ifCond";
}

const OPS = ["equals", "not equals", "contains", "greater than", "less than", "is empty", "is not empty"];
const opNeedsValue = (op: string) => op !== "is empty" && op !== "is not empty";

/** Default config params for a freshly-dropped node of `kind` (no `kind`/`position` — the canvas
 *  adds those). Field names match the executor. */
export function resetItemNode(kind: FlowItemKind): Record<string, unknown> {
  switch (kind) {
    case "httpRequest": return { method: "GET", url: "", headers: "", body: "", saveAs: "" };
    case "setVar": return { name: "", value: "" };
    case "setFields": return { fields: "{\n  \n}", mode: "merge" };
    case "filter": return { field: "text", op: "is not empty", value: "" };
    case "merge": return {};
    case "aggregate": return { op: "count", field: "text", separator: "\\n" };
    case "ifCond": return { left: "", op: "equals", right: "" };
    case "code": return { code: "// items: Item[] in, Item[] out\nreturn items;" };
    case "openUrl": return { url: "" };
    case "waitFor": return { selector: "", ms: 1000 };
    case "clickSelector": return { selector: "" };
    case "typeText": return { selector: "", text: "" };
    case "selectOption": return { selector: "", value: "" };
    case "hover": return { selector: "" };
    case "scroll": return { amount: 800 };
    case "pressKey": return { key: "Enter" };
    case "getText": return { selector: "", saveAs: "" };
    case "screenshot": return {};
    case "navBack": return {};
    case "navForward": return {};
    case "reload": return {};
    case "act": return { action: "" };
    case "observe": return { instruction: "" };
    case "extract": return { instruction: "", saveAs: "" };
    case "agent": return { instruction: "" };
  }
}

const str = (c: Record<string, unknown>, k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");

/** The one-line canvas subtitle — the node's most identifying param, truncated by the card. */
export function itemKindSubtitle(kind: string, config: Record<string, unknown>): string | undefined {
  switch (kind) {
    case "httpRequest": return `${str(config, "method") || "GET"} ${str(config, "url") || "…"}`.trim();
    case "setVar": return str(config, "name") ? `vars.${str(config, "name")}` : undefined;
    case "filter": return `${str(config, "field") || "text"} ${str(config, "op") || ""}`.trim();
    case "aggregate": return str(config, "op") || "count";
    case "ifCond": return `${str(config, "left") || "…"} ${str(config, "op") || "equals"} ${str(config, "right")}`.trim();
    case "openUrl": return str(config, "url") || undefined;
    case "clickSelector": case "hover": case "getText": case "waitFor": return str(config, "selector") || undefined;
    case "typeText": return str(config, "selector") || undefined;
    case "pressKey": return str(config, "key") || undefined;
    case "act": return str(config, "action") || undefined;
    case "observe": case "extract": case "agent": return str(config, "instruction") || undefined;
    default: return undefined;
  }
}

/** True when a node still needs a load-bearing field before it can run — surfaces the amber dot. */
export function itemNodeIncomplete(kind: string, config: Record<string, unknown>): boolean {
  const has = (k: string) => str(config, k).trim() !== "";
  switch (kind) {
    case "httpRequest": case "openUrl": return !has("url");
    case "setVar": return !has("name");
    case "clickSelector": case "hover": case "getText": return !has("selector");
    case "typeText": return !has("selector") || !has("text");
    case "selectOption": return !has("selector") || !has("value");
    case "waitFor": return !has("selector") && !(Number(config.ms) > 0);
    case "act": return !has("action");
    case "observe": case "extract": case "agent": return !has("instruction");
    case "ifCond": return !has("left");
    case "code": return !has("code");
    default: return false;
  }
}

// ── the {{…}} templating picker ──────────────────────────────────────────────────
// Item nodes read upstream data via studio-style tokens: {{text}} / {{json.x}} the incoming item,
// {{vars.x}} a saved variable, {{steps.<id>.text}} an earlier node's output. The picker appends a
// token to a templatable field — a lightweight, honest affordance (no cursor tracking).
const TOKENS: { token: string; label: string }[] = [
  { token: "{{text}}", label: "Item text" },
  { token: "{{json.value}}", label: "Item JSON field" },
  { token: "{{vars.name}}", label: "Saved variable" },
  { token: "{{steps.NODE.text}}", label: "Another step's output" },
];

export function VarPicker({ onInsert }: { onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      width={224}
      className="p-1"
      trigger={
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={() => setOpen((o) => !o)}>
          <Braces className="size-3" /> Insert variable
        </Button>
      }
    >
      <ul className="space-y-0.5">
        {TOKENS.map((t) => (
          <li key={t.token}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              onClick={() => { onInsert(t.token); setOpen(false); }}
            >
              <span className="text-muted-foreground">{t.label}</span>
              <code className="font-mono text-[11px] text-foreground">{t.token}</code>
            </button>
          </li>
        ))}
      </ul>
    </Popover>
  );
}

// ── field primitives ─────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** A text/textarea field with a VarPicker in its label row — the templatable field pattern. */
function TplField({
  label, value, onChange, placeholder, area, mono,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; area?: boolean; mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <VarPicker onInsert={(t) => onChange(value + t)} />
      </div>
      {area ? (
        <Textarea autoGrow value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className={mono ? "font-mono text-xs" : "text-sm"} />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={mono ? "font-mono text-xs" : undefined} />
      )}
    </div>
  );
}

// ── the per-kind inspector form ────────────────────────────────────────────────────
export function ItemFields({
  kind, config, onChange,
}: {
  kind: FlowItemKind;
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const s = (k: string) => str(config, k);
  const combo = (opts: string[]) => opts.map((o) => ({ value: o, label: o }));

  switch (kind) {
    case "httpRequest": {
      const method = s("method") || "GET";
      const bodyless = method === "GET" || method === "HEAD" || method === "DELETE";
      return (
        <div className="space-y-2">
          <Field label="Method">
            <Combobox value={method} onChange={(v) => onChange({ method: v })} options={combo(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])} />
          </Field>
          <TplField label="URL" value={s("url")} onChange={(v) => onChange({ url: v })} placeholder="https://api.example.com/…" mono />
          <TplField label="Headers (k: v per line)" value={s("headers")} onChange={(v) => onChange({ headers: v })} placeholder={"Authorization: Bearer …"} area mono />
          {!bodyless && <TplField label="Body" value={s("body")} onChange={(v) => onChange({ body: v })} placeholder={'{ "hello": "{{text}}" }'} area mono />}
          <Field label="Save response as (vars.<name>, optional)">
            <Input value={s("saveAs")} onChange={(e) => onChange({ saveAs: e.target.value })} placeholder="apiResult" />
          </Field>
        </div>
      );
    }
    case "setVar":
      return (
        <div className="space-y-2">
          <Field label="Variable name"><Input value={s("name")} onChange={(e) => onChange({ name: e.target.value })} placeholder="ticketUrl" /></Field>
          <TplField label="Value" value={s("value")} onChange={(v) => onChange({ value: v })} placeholder="{{json.body.id}}" />
        </div>
      );
    case "setFields":
      return (
        <div className="space-y-2">
          <TplField label="Fields (JSON)" value={s("fields")} onChange={(v) => onChange({ fields: v })} area mono placeholder={'{ "status": "open" }'} />
          <Field label="Mode">
            <Combobox value={s("mode") || "merge"} onChange={(v) => onChange({ mode: v })} options={[{ value: "merge", label: "Merge onto item" }, { value: "replace", label: "Replace item json" }]} />
          </Field>
        </div>
      );
    case "filter": {
      const op = s("op") || "is not empty";
      return (
        <div className="space-y-2">
          <TplField label="Field" value={s("field") || "text"} onChange={(v) => onChange({ field: v })} placeholder="text or json.path" mono />
          <Field label="Keep when"><Combobox value={op} onChange={(v) => onChange({ op: v })} options={combo(OPS)} /></Field>
          {opNeedsValue(op) && <TplField label="Value" value={s("value")} onChange={(v) => onChange({ value: v })} />}
        </div>
      );
    }
    case "merge":
      return <p className="text-xs text-muted-foreground">Passes every input item straight through — wire two or more branches into this node to combine their items into one stream.</p>;
    case "aggregate": {
      const op = s("op") || "count";
      return (
        <div className="space-y-2">
          <Field label="Reduce to"><Combobox value={op} onChange={(v) => onChange({ op: v })} options={[
            { value: "count", label: "Count of items" },
            { value: "concatenate", label: "Concatenate text" },
            { value: "collect", label: "Collect field values" },
            { value: "sum", label: "Sum a numeric field" },
          ]} /></Field>
          {(op === "collect" || op === "sum") && <TplField label="Field" value={s("field") || "text"} onChange={(v) => onChange({ field: v })} placeholder="json.amount" mono />}
          {op === "concatenate" && <Field label="Separator"><Input value={s("separator") || "\\n"} onChange={(e) => onChange({ separator: e.target.value })} placeholder="\n" className="font-mono text-xs" /></Field>}
        </div>
      );
    }
    case "ifCond": {
      const op = s("op") || "equals";
      return (
        <div className="space-y-2">
          <TplField label="Left" value={s("left")} onChange={(v) => onChange({ left: v })} placeholder="{{json.status}}" />
          <Field label="Is"><Combobox value={op} onChange={(v) => onChange({ op: v })} options={combo(OPS)} /></Field>
          {opNeedsValue(op) && <TplField label="Right" value={s("right")} onChange={(v) => onChange({ right: v })} />}
          <p className="text-xs text-muted-foreground">Routes the <span className="font-medium text-emerald-600 dark:text-emerald-400">yes</span> / <span className="font-medium">no</span> paths.</p>
        </div>
      );
    }
    case "code":
      return <TplField label="JavaScript (items in → items out)" value={s("code")} onChange={(v) => onChange({ code: v })} area mono />;

    case "openUrl":
      return <TplField label="URL" value={s("url")} onChange={(v) => onChange({ url: v })} placeholder="https://example.com" mono />;
    case "waitFor":
      return (
        <div className="space-y-2">
          <TplField label="CSS selector (optional)" value={s("selector")} onChange={(v) => onChange({ selector: v })} placeholder="#results" mono />
          <Field label="…or wait (ms)"><Input type="number" min={0} value={String(config.ms ?? 1000)} onChange={(e) => onChange({ ms: Math.max(0, Number(e.target.value) || 0) })} /></Field>
        </div>
      );
    case "clickSelector": case "hover":
      return <TplField label="CSS selector" value={s("selector")} onChange={(v) => onChange({ selector: v })} placeholder="button.submit" mono />;
    case "typeText":
      return (
        <div className="space-y-2">
          <TplField label="CSS selector" value={s("selector")} onChange={(v) => onChange({ selector: v })} placeholder="input[name=q]" mono />
          <TplField label="Text" value={s("text")} onChange={(v) => onChange({ text: v })} placeholder="{{text}}" />
        </div>
      );
    case "selectOption":
      return (
        <div className="space-y-2">
          <TplField label="CSS selector" value={s("selector")} onChange={(v) => onChange({ selector: v })} placeholder="select#country" mono />
          <TplField label="Option value" value={s("value")} onChange={(v) => onChange({ value: v })} />
        </div>
      );
    case "scroll":
      return <Field label="Scroll by (px)"><Input type="number" value={String(config.amount ?? 800)} onChange={(e) => onChange({ amount: Number(e.target.value) || 0 })} /></Field>;
    case "pressKey":
      return <Field label="Key"><Input value={s("key") || "Enter"} onChange={(e) => onChange({ key: e.target.value })} placeholder="Enter" /></Field>;
    case "getText":
      return (
        <div className="space-y-2">
          <TplField label="CSS selector" value={s("selector")} onChange={(v) => onChange({ selector: v })} placeholder="h1" mono />
          <Field label="Save as (vars.<name>, optional)"><Input value={s("saveAs")} onChange={(e) => onChange({ saveAs: e.target.value })} placeholder="heading" /></Field>
        </div>
      );
    case "screenshot": case "navBack": case "navForward": case "reload":
      return <p className="text-xs text-muted-foreground">No configuration — this step runs on the current browser page.</p>;

    case "act":
      return <TplField label="Action (natural language)" value={s("action")} onChange={(v) => onChange({ action: v })} placeholder="click the sign-in button" area />;
    case "observe":
      return <TplField label="What to find" value={s("instruction")} onChange={(v) => onChange({ instruction: v })} placeholder="the search results list" area />;
    case "extract":
      return (
        <div className="space-y-2">
          <TplField label="What to extract" value={s("instruction")} onChange={(v) => onChange({ instruction: v })} placeholder="the top result's title and url" area />
          <Field label="Save as (vars.<name>, optional)"><Input value={s("saveAs")} onChange={(e) => onChange({ saveAs: e.target.value })} placeholder="topResult" /></Field>
        </div>
      );
    case "agent":
      return <TplField label="Goal for the browsing agent" value={s("instruction")} onChange={(v) => onChange({ instruction: v })} placeholder="find the cheapest flight and read its price" area />;
  }
}
