import type { ReactNode } from "react";
import { ArrowUpRight, ArrowDown, Check, Container, Users2, GitBranch, BookOpen, ShieldCheck } from "lucide-react";
import { ChannelMerge, AnswerMock, StudioMock, ChannelGlyph, CHANNEL, type ChannelKey } from "./mocks";
import { buttonVariants } from "./ui/button";
import { Reveal } from "./reveal";
import { cn } from "../lib/utils";
import { DEMO_URL } from "../lib/links";

// ── shared scaffolding ────────────────────────────────────────────────────────
function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-28", className)}>
      {children}
    </section>
  );
}

function SectionHead({ eyebrow, title, lead }: { eyebrow: string; title: string; lead?: string }) {
  return (
    <div className="max-w-2xl">
      <Reveal>
        <div className="eyebrow text-primary/80">{eyebrow}</div>
      </Reveal>
      <Reveal delay={60}>
        <h2 className="display-l mt-3">{title}</h2>
      </Reveal>
      {lead && (
        <Reveal delay={120}>
          <p className="lead mt-4 text-muted-foreground">{lead}</p>
        </Reveal>
      )}
    </div>
  );
}

function Capability({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
      <span className="text-small text-muted-foreground">{children}</span>
    </div>
  );
}

// ── 1 · The problem ───────────────────────────────────────────────────────────
export function Problem() {
  return (
    <Section id="problem">
      <SectionHead
        eyebrow="The problem"
        title="Your users don't file tickets. They post in Discord."
        lead="Support scatters across Discord threads, DMs, a widget, email — each with its own identity, none of them a queue. The context lives in five places and the person lives in none."
      />
      <Reveal delay={120} className="mt-12 rounded-xl border border-border bg-muted/20 p-6 sm:p-8">
        <ChannelMerge />
      </Reveal>
      <Reveal delay={80}>
        <p className="mt-6 max-w-2xl text-small text-muted-foreground">
          Noola keys every channel to <span className="text-foreground">one person</span> — so a conversation is a
          conversation, wherever it started, and the history follows them across all of it.
        </p>
      </Reveal>
    </Section>
  );
}

// ── 2 · AI answers ────────────────────────────────────────────────────────────
export function Answers() {
  return (
    <div className="border-y border-border/60 bg-muted/20">
      <Section id="answers">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
          <div>
            <SectionHead
              eyebrow="AI answers · Copilot"
              title="Resolve the repeatable half. Route the rest."
              lead="Noola drafts from your own docs, code, and past threads — with citations and a confidence score. Above the bar it answers in-thread; below it, a human gets the draft instead of a guess."
            />
            <div className="mt-8 flex flex-col gap-3.5">
              <Capability icon={<BookOpen className="size-3" />}>
                Every answer cites its sources — docs, changelog, resolved threads.
              </Capability>
              <Capability icon={<ShieldCheck className="size-3" />}>
                Confidence-gated: it never posts below the bar you set.
              </Capability>
              <Capability icon={<Check className="size-3" />}>
                Human-in-the-loop drafts, so an agent approves — or edits — before it sends.
              </Capability>
            </div>
          </div>
          <Reveal delay={120}>
            <AnswerMock />
          </Reveal>
        </div>
      </Section>
    </div>
  );
}

// ── 3 · Agent Studio (the wedge) ──────────────────────────────────────────────
export function Studio() {
  return (
    <Section id="studio">
      <SectionHead
        eyebrow="Agent Studio"
        title="Not a chatbot. A studio that does the work."
        lead="A multiplayer canvas where support becomes a flow: a thread opens, the risk gets classified, an agent probes your status page in a real container, then it routes to the right team or posts the answer. Real logic, real side-effects — not just deflection."
      />
      <Reveal delay={140} className="mt-12">
        <StudioMock />
      </Reveal>
      <div className="mt-8 grid gap-3.5 sm:grid-cols-3">
        <Reveal delay={80}>
          <Capability icon={<Container className="size-3" />}>
            Agent nodes run a real container per job — probe a URL, run a check, call a tool.
          </Capability>
        </Reveal>
        <Reveal delay={140}>
          <Capability icon={<Users2 className="size-3" />}>
            A live, multiplayer canvas — build the flow together, watch a run light up.
          </Capability>
        </Reveal>
        <Reveal delay={200}>
          <Capability icon={<GitBranch className="size-3" />}>
            Branch on an AI classification — risk, topic, sentiment — then fan out.
          </Capability>
        </Reveal>
      </div>
    </Section>
  );
}

// ── 4 · Channels ──────────────────────────────────────────────────────────────
type ChannelCard = { ch: ChannelKey; body: string; featured?: boolean };
const CHANNEL_CARDS: ChannelCard[] = [
  { ch: "discord", body: "Thread = ticket. Reactions triage, roles map to identity, and answers post back to the channel. The whole community is the queue.", featured: true },
  { ch: "email", body: "Full threading, attachments, CC — a real ESP behind a driver seam." },
  { ch: "widget", body: "Streaming AI answers, markdown, attachments both directions." },
  { ch: "slack", body: "An answer-bot in-channel; escalate to a human thread on demand." },
  { ch: "telegram", body: "Self-serve connect. Same person, same inbox." },
  { ch: "whatsapp", body: "Self-serve connect. Same person, same inbox." },
  { ch: "api", body: "REST v1 + OpenAPI, and an MCP server your own agents can call." },
];

export function Channels() {
  return (
    <div className="border-y border-border/60 bg-muted/20">
      <Section id="channels">
        <SectionHead eyebrow="Every channel" title="One inbox. Seven doors in." />
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CHANNEL_CARDS.map((c, i) => (
            <Reveal key={c.ch} delay={i * 50} className={cn(c.featured && "sm:col-span-2 lg:col-span-1 lg:row-span-2")}>
              <div
                className={cn(
                  "raised flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-border/80",
                  c.featured && "lg:justify-between lg:bg-gradient-to-b lg:from-card lg:to-muted/30",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="grid size-8 place-items-center rounded-lg"
                    style={{ background: `color-mix(in oklab, ${CHANNEL[c.ch].color} 18%, transparent)`, color: CHANNEL[c.ch].color }}
                  >
                    <ChannelGlyph channel={c.ch} className="size-4" />
                  </span>
                  <span className="display-m !text-[1.05rem]">{CHANNEL[c.ch].label}</span>
                  {c.featured && (
                    <span className="mono ml-auto rounded bg-primary/10 px-1.5 py-0.5 text-[0.6rem] font-medium text-primary">
                      flagship
                    </span>
                  )}
                </div>
                <p className={cn("text-small leading-relaxed text-muted-foreground", c.featured && "lg:text-[0.9rem]")}>
                  {c.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── 5 · Developers / Enterprise ───────────────────────────────────────────────
const ENTERPRISE = [
  "SSO — SAML & OIDC",
  "SCIM user + group provisioning",
  "TOTP two-factor",
  "Immutable audit log",
  "GDPR export & erase",
  "IP allow-list",
  "Configurable data retention",
];

export function Developers() {
  return (
    <Section id="developers">
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead
            eyebrow="Built for engineers"
            title="API-first, wired for the enterprise."
            lead="Everything the UI does, the API does — streaming answers included. Bring your own model key; call it from your own agents over MCP."
          />
          <Reveal delay={120} className="mt-8">
            <div className="raised overflow-hidden rounded-xl border border-border bg-[#0b0b0a] text-[#e9e8e3]">
              <div className="flex items-center gap-1.5 border-b border-white/10 px-3.5 py-2">
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="mono ml-1 text-[0.62rem] text-white/40">ask.sh</span>
              </div>
              <pre className="mono overflow-x-auto px-4 py-3.5 text-[0.72rem] leading-relaxed">
                <span className="text-white/45"># stream an answer from your own knowledge</span>
                {"\n"}
                <span className="text-[#7a99b8]">curl</span> -N https://api.noola.dev/public/ask/stream \{"\n"}
                {"  "}-H <span className="text-[#4fb08d]">"authorization: Bearer $NOOLA_KEY"</span> \{"\n"}
                {"  "}-d <span className="text-[#4fb08d]">{`'{"query":"how do webhook retries work?"}'`}</span>
                {"\n\n"}
                <span className="text-white/45"># ← server-sent tokens, with citations</span>
                {"\n"}
                <span className="text-[#efa43c]">event:</span> token{"   "}
                <span className="text-[#efa43c]">data:</span> "Failed deliveries retry with"{"\n"}
                <span className="text-[#efa43c]">event:</span> source{"  "}
                <span className="text-[#efa43c]">data:</span> {`{"title":"docs/webhooks.md"}`}
                {"\n"}
                <span className="text-[#efa43c]">event:</span> done{"   "}
                <span className="text-[#efa43c]">data:</span> {`{"confidence":0.94,"resolved":true}`}
              </pre>
            </div>
          </Reveal>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
            {["API v1 + OpenAPI", "TypeScript SDK", "MCP server", "Webhooks · retries + DLQ"].map((x) => (
              <span key={x} className="inline-flex items-center gap-1.5 text-small text-muted-foreground">
                <Check className="size-3.5 text-success" /> {x}
              </span>
            ))}
          </div>
        </div>

        <Reveal delay={160}>
          <div className="rounded-xl border border-border bg-muted/20 p-6 sm:p-8">
            <div className="eyebrow flex items-center gap-2 text-muted-foreground">
              <ShieldCheck className="size-3.5 text-success" /> Enterprise-ready
            </div>
            <ul className="mt-5 flex flex-col divide-y divide-border/60">
              {ENTERPRISE.map((e) => (
                <li key={e} className="flex items-center gap-3 py-3 text-[0.9rem]">
                  <Check className="size-4 shrink-0 text-success" />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

// ── 6 · Pricing — honest early access, not invented dollar tiers ──────────────
const INCLUDED = [
  "Every channel — Discord, email, Slack, widget, Telegram, WhatsApp",
  "Agent Studio + the container runner",
  "AI answers & Copilot (bring your own model key)",
  "SSO, SCIM, 2FA, audit log, GDPR tools",
  "API v1, OpenAPI, SDK & MCP server",
];

export function Pricing() {
  return (
    <div className="border-y border-border/60 bg-muted/20">
      <Section id="pricing">
        <SectionHead
          eyebrow="Pricing"
          title="Free while we're in beta."
          lead="Noola is early and building in the open. Self-serve, Discord-native, bring your own model key. Pricing lands at GA — until then, running the whole thing costs nothing."
        />
        <div className="mt-12 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Reveal>
            <div className="raised relative overflow-hidden rounded-2xl border border-primary/40 bg-card p-7 sm:p-9">
              <div className="absolute right-6 top-6">
                <span className="relative grid size-2.5 place-items-center">
                  <span className="sonar-ring" />
                  <span className="size-2 rounded-full bg-primary" />
                </span>
              </div>
              <div className="eyebrow text-primary">Early access</div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="display-l">Free</span>
                <span className="text-small text-muted-foreground">during beta</span>
              </div>
              <ul className="mt-6 grid gap-2.5">
                {INCLUDED.map((x) => (
                  <li key={x} className="flex items-start gap-2.5 text-small">
                    <Check className="mt-0.5 size-4 shrink-0 text-success" />
                    <span className="text-muted-foreground">{x}</span>
                  </li>
                ))}
              </ul>
              <a
                href={DEMO_URL}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ variant: "signal", size: "lg" }), "mt-8 w-full")}
              >
                See the live demo
                <ArrowUpRight className="size-4" />
              </a>
            </div>
          </Reveal>
          <Reveal delay={100}>
            <div className="flex h-full flex-col justify-center gap-4 rounded-2xl border border-border bg-muted/20 p-7 sm:p-9">
              <div className="display-m">Teams &amp; scale</div>
              <p className="text-small leading-relaxed text-muted-foreground">
                Higher volumes, dedicated routing, and a promote-to-production path land with general availability.
                We'd rather earn that conversation than invent a price for it today.
              </p>
              <a href="#developers" className={cn(buttonVariants({ variant: "outline" }), "w-fit")}>
                See what's built
                <ArrowDown className="size-4" />
              </a>
            </div>
          </Reveal>
        </div>
      </Section>
    </div>
  );
}

// ── 7 · Final CTA — the sonar returns, closing the loop ───────────────────────
export function FinalCta() {
  return (
    <Section className="text-center">
      <Reveal className="mx-auto flex max-w-2xl flex-col items-center">
        <div className="relative mb-8 grid size-3 place-items-center" aria-hidden="true">
          <span className="sonar-ring" style={{ animationDelay: "0s" }} />
          <span className="sonar-ring" style={{ animationDelay: "1s" }} />
          <span className="sonar-ring" style={{ animationDelay: "2s" }} />
          <span className="size-2.5 rounded-full bg-primary" />
        </div>
        <h2 className="display-l">Point Noola at your Discord.</h2>
        <p className="lead mt-4 text-muted-foreground">
          Spin up the inbox, wire a channel, and watch the repeatable half resolve itself.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
          <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "signal", size: "lg" }))}>
            See the live demo
            <ArrowUpRight className="size-4" />
          </a>
          <a href="#top" className={cn(buttonVariants({ variant: "ghost", size: "lg" }))}>
            Back to the top
          </a>
        </div>
      </Reveal>
    </Section>
  );
}
