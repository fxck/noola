import {
  Mail,
  MessageSquare,
  Send,
  Phone,
  Terminal,
  Hash,
  Sparkles,
  ArrowRight,
  ShieldAlert,
  CircleCheck,
  Check,
  BookOpen,
} from "lucide-react";
import { cn } from "../lib/utils";

// ── Channels ────────────────────────────────────────────────────────────────
// Each channel gets a color from the harmonized categorical set (never a raw brand hex — the whole
// page stays one warm system). Labels + glyphs are real; these are the channels the product speaks.
export type ChannelKey = "discord" | "email" | "widget" | "slack" | "telegram" | "whatsapp" | "api";

export const CHANNEL: Record<ChannelKey, { label: string; color: string; short: string }> = {
  discord: { label: "Discord", color: "var(--chart-4)", short: "Discord" },
  email: { label: "Email", color: "var(--chart-1)", short: "Email" },
  widget: { label: "In-app widget", color: "var(--chart-2)", short: "Widget" },
  slack: { label: "Slack", color: "var(--chart-6)", short: "Slack" },
  telegram: { label: "Telegram", color: "var(--chart-7)", short: "Telegram" },
  whatsapp: { label: "WhatsApp", color: "var(--chart-5)", short: "WhatsApp" },
  api: { label: "API · MCP", color: "var(--chart-3)", short: "API" },
};

export function ChannelGlyph({ channel, className }: { channel: ChannelKey; className?: string }) {
  const c = cn("size-3.5", className);
  switch (channel) {
    case "discord":
      return (
        <svg viewBox="0 0 24 24" className={c} fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      );
    case "email":
      return <Mail className={c} />;
    case "widget":
      return <MessageSquare className={c} />;
    case "slack":
      return <Hash className={c} />;
    case "telegram":
      return <Send className={c} />;
    case "whatsapp":
      return <Phone className={c} />;
    case "api":
      return <Terminal className={c} />;
  }
}

/** A monogram avatar tile — brand-colored, never a stock photo. */
export function Monogram({ name, className, style }: { name: string; className?: string; style?: React.CSSProperties }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full text-[0.7rem] font-semibold text-primary-foreground",
        className,
      )}
      style={style}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

function ChannelDot({ channel }: { channel: ChannelKey }) {
  return <span className="size-1.5 shrink-0 rounded-full" style={{ background: CHANNEL[channel].color }} aria-hidden="true" />;
}

// ── The omnichannel inbox — the hero centerpiece. One contact, three channels, one thread; a human
//    kept in the loop over an AI draft with a real confidence chip. Sample data, honest UI. ──────
export function InboxMock() {
  return (
    <div className="raised overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-2xl shadow-black/20">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3.5 py-2.5">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
          <span className="size-2.5 rounded-full bg-foreground/15" />
        </div>
        <span className="ml-1 text-small font-medium text-muted-foreground">Inbox</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1">
          <span className="mono text-[0.65rem] text-muted-foreground">SLA</span>
          <span className="mono text-[0.72rem] font-medium text-primary">04:12</span>
        </span>
      </div>

      <div className="grid grid-cols-[1fr] sm:grid-cols-[148px_1fr]">
        {/* conversation rail */}
        <div className="hidden flex-col border-r border-border/60 sm:flex">
          {[
            { n: "Aria Fontaine", s: "Deploy keeps failing…", ch: "discord" as ChannelKey, t: "2m", active: true },
            { n: "Devin Park", s: "Invoice question", ch: "email" as ChannelKey, t: "14m", active: false },
            { n: "Sofia Nunes", s: "Rate limit on /ask", ch: "api" as ChannelKey, t: "31m", active: false },
          ].map((r) => (
            <div
              key={r.n}
              className={cn(
                "flex flex-col gap-1 border-b border-border/40 px-3 py-2.5",
                r.active && "bg-accent/60",
              )}
            >
              <div className="flex items-center gap-1.5">
                <ChannelDot channel={r.ch} />
                <span className="min-w-0 flex-1 truncate text-[0.72rem] font-medium">{r.n}</span>
                <span className="mono text-[0.6rem] text-muted-foreground">{r.t}</span>
              </div>
              <span className="truncate text-[0.68rem] text-muted-foreground">{r.s}</span>
            </div>
          ))}
        </div>

        {/* thread */}
        <div className="flex min-w-0 flex-col">
          {/* contact header — the omnichannel identity: one person, three channels merged */}
          <div className="flex items-center gap-2.5 border-b border-border/60 px-3.5 py-2.5">
            <Monogram name="Aria Fontaine" className="size-7" style={{ background: "var(--chart-4)" }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[0.8rem] font-semibold">Aria Fontaine</span>
                <span className="flex items-center gap-0.5">
                  <span className="size-1.5 rounded-full bg-success" />
                  <span className="text-[0.62rem] font-medium text-success">Active now</span>
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                {(["discord", "widget", "email"] as ChannelKey[]).map((ch) => (
                  <span
                    key={ch}
                    className="inline-flex items-center gap-1 rounded border border-border/60 px-1 py-px text-[0.6rem] text-muted-foreground"
                    style={{ color: CHANNEL[ch].color }}
                    title={CHANNEL[ch].label}
                  >
                    <ChannelGlyph channel={ch} className="size-2.5" />
                  </span>
                ))}
                <span className="mono ml-1 text-[0.6rem] text-muted-foreground">1 identity</span>
              </div>
            </div>
          </div>

          {/* messages */}
          <div className="flex flex-col gap-3 px-3.5 py-3.5">
            <Bubble channel="discord" author="Aria" time="2m">
              Deploy keeps failing on the musl step — <span className="mono text-[0.78em] text-foreground/90">npm ci</span> can't
              find the Rollup binary.
            </Bubble>
            <Bubble channel="widget" author="Aria" time="1m">
              Posting here too in case Discord's quiet — same build, 502 on the health check.
            </Bubble>

            {/* AI draft — a human is kept in the loop; confidence is shown, not hidden */}
            <div className="rounded-lg border border-primary/30 bg-primary/[0.055] p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5">
                <Sparkles className="size-3 text-primary" />
                <span className="text-[0.66rem] font-medium text-primary">Suggested reply</span>
                <span className="mono ml-auto rounded bg-primary/10 px-1.5 py-px text-[0.62rem] font-medium text-primary">
                  92% confident
                </span>
              </div>
              <p className="text-[0.76rem] leading-relaxed text-foreground/90">
                On Alpine, use <span className="mono text-[0.82em]">npm install</span> so npm resolves the musl Rollup binary —{" "}
                <span className="mono text-[0.82em]">npm ci</span> pins the glibc one. The 502 clears once the build succeeds.
                <span className="caret" />
              </p>
              <div className="mt-2 flex items-center gap-1.5">
                <button className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.68rem] font-medium text-primary-foreground">
                  <Check className="size-3" /> Approve &amp; send
                </button>
                <button className="rounded-md border border-border px-2 py-1 text-[0.68rem] text-foreground/80">Edit</button>
                <span className="mono ml-auto flex items-center gap-1 text-[0.6rem] text-muted-foreground">
                  <BookOpen className="size-2.5" /> 2 sources
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  channel,
  author,
  time,
  children,
}: {
  channel: ChannelKey;
  author: string;
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <span
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full"
        style={{ background: `color-mix(in oklab, ${CHANNEL[channel].color} 22%, transparent)`, color: CHANNEL[channel].color }}
      >
        <ChannelGlyph channel={channel} className="size-3" />
      </span>
      <div className="min-w-0">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="text-[0.7rem] font-medium">{author}</span>
          <span className="text-[0.6rem] text-muted-foreground" style={{ color: CHANNEL[channel].color }}>
            {CHANNEL[channel].short}
          </span>
          <span className="mono text-[0.58rem] text-muted-foreground">{time}</span>
        </div>
        <div className="rounded-lg rounded-tl-sm border border-border/60 bg-muted/40 px-2.5 py-1.5 text-[0.76rem] leading-relaxed text-foreground/90">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── The channel-merge — five scattered chips collapsing into one thread (the problem visual). ──
export function ChannelMerge() {
  const scattered: ChannelKey[] = ["discord", "email", "widget", "slack", "telegram"];
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
      <div className="flex flex-wrap gap-2">
        {scattered.map((ch) => (
          <span
            key={ch}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-small"
            style={{ color: CHANNEL[ch].color }}
          >
            <ChannelGlyph channel={ch} className="size-3" />
            <span className="text-foreground/80">{CHANNEL[ch].short}</span>
          </span>
        ))}
      </div>
      <div className="flex items-center justify-center text-muted-foreground">
        <ArrowRight className="size-5 rotate-90 sm:rotate-0" />
      </div>
      <div className="raised flex items-center gap-2.5 rounded-lg border border-border bg-card p-2.5">
        <Monogram name="Aria Fontaine" className="size-8" style={{ background: "var(--chart-4)" }} />
        <div className="min-w-0">
          <div className="truncate text-[0.8rem] font-semibold">Aria Fontaine</div>
          <div className="mt-0.5 flex items-center gap-1">
            {scattered.map((ch) => (
              <span key={ch} style={{ color: CHANNEL[ch].color }}>
                <ChannelGlyph channel={ch} className="size-3" />
              </span>
            ))}
            <span className="mono ml-1 text-[0.6rem] text-muted-foreground">one thread</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The AI-answer beat — a question, a streamed answer, cited sources, a confidence-gated route. ──
export function AnswerMock() {
  return (
    <div className="raised overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <ChannelGlyph channel="discord" className="size-3.5" />
          <span className="text-small text-muted-foreground">#help · thread</span>
        </div>
        <p className="mt-1.5 text-[0.9rem] font-medium">Does the webhook retry on a 500, or do I lose the event?</p>
      </div>
      <div className="px-4 py-3.5">
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles className="size-3.5 text-primary" />
          <span className="text-small font-medium text-primary">Noola</span>
          <span className="mono ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[0.62rem] font-medium text-primary">
            resolved · 94%
          </span>
        </div>
        <p className="text-[0.85rem] leading-relaxed text-foreground/90">
          Yes — failed deliveries retry with exponential backoff for up to{" "}
          <span className="mono text-[0.82em]">24h</span> (6 attempts). After that the event lands in the dead-letter
          queue, replayable from <span className="mono text-[0.82em]">Settings → Webhooks</span>.<span className="caret" />
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mono inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[0.62rem] text-muted-foreground">
            <BookOpen className="size-2.5" /> docs/webhooks.md
          </span>
          <span className="mono inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[0.62rem] text-muted-foreground">
            <BookOpen className="size-2.5" /> changelog #482
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 bg-muted/30 px-4 py-2.5 text-[0.72rem]">
        <CircleCheck className="size-3.5 text-success" />
        <span className="text-muted-foreground">
          Above the confidence bar → answered in-thread. Below it → routed to a human, never guessed.
        </span>
      </div>
    </div>
  );
}

// ── Agent Studio — the wedge. A node canvas: trigger → classify → an agent that live-probes in a
//    container → fan-out. One node is running (amber pulse). Scrolls horizontally on narrow screens. ──
type Node = { id: string; x: number; y: number; title: string; kind: string; running?: boolean; icon: React.ReactNode; accent?: string };

export function StudioMock() {
  const nodes: Node[] = [
    { id: "trg", x: 16, y: 116, title: "New Discord thread", kind: "Trigger", icon: <ChannelGlyph channel="discord" className="size-3" />, accent: "var(--chart-4)" },
    { id: "cls", x: 210, y: 116, title: "Classify · risk", kind: "AI", icon: <ShieldAlert className="size-3" />, accent: "var(--chart-1)" },
    { id: "agt", x: 404, y: 116, title: "Agent · probe status page", kind: "Container", running: true, icon: <Terminal className="size-3" />, accent: "var(--primary)" },
    { id: "rte", x: 404, y: 24, title: "Route → Frontline", kind: "Action", icon: <ArrowRight className="size-3" />, accent: "var(--chart-2)" },
    { id: "kb", x: 404, y: 208, title: "Post KB answer", kind: "Action", icon: <BookOpen className="size-3" />, accent: "var(--chart-2)" },
  ];
  const nodeW = 172;
  const edges = [
    ["trg", "cls"],
    ["cls", "agt"],
  ];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const port = (n: Node, side: "l" | "r" | "t" | "b") => {
    const cx = n.x + (side === "r" ? nodeW : side === "l" ? 0 : nodeW / 2);
    const cy = n.y + (side === "b" ? 60 : side === "t" ? 0 : 30);
    return { cx, cy };
  };

  return (
    <div className="raised overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3.5 py-2.5">
        <span className="text-small font-medium text-muted-foreground">Studio · Triage community threads</span>
        <span className="mono ml-auto flex items-center gap-1.5 text-[0.62rem] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" /> live · 2 editing
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid-lines relative h-[300px] w-[600px]">
          <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 300" fill="none" aria-hidden="true">
            {edges.map(([a, b]) => {
              const p1 = port(byId[a], "r");
              const p2 = port(byId[b], "l");
              const mx = (p1.cx + p2.cx) / 2;
              return (
                <path
                  key={a + b}
                  d={`M ${p1.cx} ${p1.cy} C ${mx} ${p1.cy}, ${mx} ${p2.cy}, ${p2.cx} ${p2.cy}`}
                  stroke="var(--border)"
                  strokeWidth="1.5"
                />
              );
            })}
            {/* fan-out from the agent to the two actions — amber (the running path) */}
            {(["rte", "kb"] as const).map((t) => {
              const p1 = port(byId["agt"], "r");
              const p2 = port(byId[t], "l");
              const mx = (p1.cx + p2.cx) / 2;
              return (
                <path
                  key={t}
                  d={`M ${p1.cx} ${p1.cy} C ${mx} ${p1.cy}, ${mx} ${p2.cy}, ${p2.cx} ${p2.cy}`}
                  stroke="color-mix(in oklab, var(--primary) 55%, transparent)"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
              );
            })}
          </svg>

          {nodes.map((n) => (
            <div
              key={n.id}
              className={cn(
                "absolute flex flex-col gap-1 rounded-lg border bg-popover px-2.5 py-2",
                n.running ? "border-primary/60 pulse-node" : "border-border",
              )}
              style={{ left: n.x, top: n.y, width: nodeW }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="grid size-4 place-items-center rounded"
                  style={{ background: `color-mix(in oklab, ${n.accent} 22%, transparent)`, color: n.accent }}
                >
                  {n.icon}
                </span>
                <span className="eyebrow text-[0.56rem] text-muted-foreground" style={{ letterSpacing: "0.1em" }}>
                  {n.kind}
                </span>
                {n.running && (
                  <span className="mono ml-auto flex items-center gap-1 text-[0.56rem] text-primary">
                    <span className="size-1.5 rounded-full bg-primary" /> running
                  </span>
                )}
              </div>
              <span className="truncate text-[0.74rem] font-medium">{n.title}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
