import type { ReactNode } from "react";
import {
  ArrowUpRight, ArrowDown, Check, Container, GitBranch, Blocks, Fingerprint, Layers, Reply,
  BookOpen, ShieldCheck, Quote,
} from "lucide-react";
import { ProductShot, ChannelGlyph, CHANNEL, type ChannelKey } from "./mocks";
import { buttonVariants } from "./ui/button";
import { Reveal } from "./reveal";
import { cn } from "../lib/utils";
import { DEMO_URL } from "../lib/links";

function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn("mx-auto max-w-6xl px-5 py-24 sm:px-8 lg:py-32", className)}>
      {children}
    </section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow text-primary">{children}</div>;
}

function Capability({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-foreground">
        <span className="text-primary">{icon}</span>
        <span className="text-[0.95rem] font-semibold tracking-tight">{title}</span>
      </div>
      <p className="mt-1.5 text-[0.9rem] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** A small caption under a product shot. */
function Caption({ children }: { children: ReactNode }) {
  return <p className="mono mt-3 text-center text-[0.68rem] text-faint">{children}</p>;
}

// ── 1 · The problem — a dark statement interlude (the product's world, as a beat) ──
export function Problem() {
  return (
    <div className="bg-graphite text-[#e9e8e3]">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8 lg:py-28">
        <Reveal>
          <p className="eyebrow text-[#8b897f]">The problem</p>
        </Reveal>
        <Reveal delay={70}>
          <h2 className="display-xl mt-5 max-w-4xl text-[#f3f2ec]">
            Support scattered across five tools isn't support.
            <span className="text-[#8b897f]"> It's archaeology.</span>
          </h2>
        </Reveal>
        <Reveal delay={130}>
          <p className="lead mt-6 max-w-2xl !text-[#a8a69b]">
            A question lands on Discord. The billing detail is buried in email. The power user pinged you on Slack.
            Every answer means five tabs, three logins, and a guess at who's actually asking.
          </p>
        </Reveal>
      </div>
    </div>
  );
}

// ── 2 · Flagship one: the omnichannel synced inbox ────────────────────────────
export function Inbox() {
  return (
    <Section id="inbox">
      <div className="max-w-2xl">
        <Reveal><Eyebrow>Omnichannel inbox</Eyebrow></Reveal>
        <Reveal delay={70}>
          <h2 className="display-xl mt-4">Every channel becomes one conversation.</h2>
        </Reveal>
        <Reveal delay={130}>
          <p className="lead mt-5">
            Noola keys every message to the person, not the channel — so a Discord thread, an email, and a widget chat
            from the same user are one conversation, not three tickets. You reply from one place; it goes back out on
            whatever channel they reached you on.
          </p>
        </Reveal>
      </div>

      {/* the same flagship, now in light — makes the light/dark theming explicit (hero was dark) */}
      <Reveal delay={120} className="mt-12">
        <ProductShot
          src="/shots/inbox-light.png"
          alt="The Noola inbox in light theme — the queue, an open conversation with an AI-suggested reply awaiting approval, and the customer context rail"
        />
        <Caption>The same inbox — in light or dark, whichever your team runs.</Caption>
      </Reveal>

      <div className="mt-12 grid gap-8 sm:grid-cols-3">
        <Reveal delay={60}>
          <Capability icon={<Fingerprint className="size-4" />} title="Identity, not inbox">
            One thread per person, merged on contact identity across every channel — never the same customer split into
            three siloed tickets.
          </Capability>
        </Reveal>
        <Reveal delay={120}>
          <Capability icon={<Layers className="size-4" />} title="No channel is second-class">
            Every channel gets the same inbox, the same AI answers, and the same automations. Parity is the design, not a
            roadmap promise.
          </Capability>
        </Reveal>
        <Reveal delay={180}>
          <Capability icon={<Reply className="size-4" />} title="Reply from one place">
            Answer once and Noola sends it on the channel they used — Discord, email, Slack, or the widget — with the
            full thread intact.
          </Capability>
        </Reveal>
      </div>
    </Section>
  );
}

// ── 3 · Flagship two: Agent Studio — n8n, but the nodes run your support desk ──
export function Studio() {
  return (
    <div className="border-y border-border bg-well">
      <Section id="studio">
        <div className="max-w-2xl">
          <Reveal><Eyebrow>Agent Studio</Eyebrow></Reveal>
          <Reveal delay={70}>
            <h2 className="display-xl mt-4">Like n8n — but the nodes run your support desk.</h2>
          </Reveal>
          <Reveal delay={130}>
            <p className="lead mt-5">
              Drag nodes onto a canvas and wire up real work. A node opens a ticket, searches your knowledge base, tags
              and routes, messages a contact, or spins up an AI agent in a throwaway container to check something live.
              The automation acts on the platform itself — not a webhook bolted onto the side of it.
            </p>
          </Reveal>
        </div>

        <Reveal delay={120} className="mt-12">
          <ProductShot
            src="/shots/canvas-dark.png"
            alt="Agent Studio canvas — a live flow: a ticket-created trigger runs an AI agent, which fans out to set priority, save an incident log to the knowledge base, and add tags"
          />
          <Caption>A live flow — trigger → AI agent → set priority · save to KB · tag.</Caption>
        </Reveal>

        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          <Reveal delay={60}>
            <Capability icon={<Blocks className="size-4" />} title="Nodes that act on the platform">
              Set priority, add tags, upsert a KB article, message a contact, open a ticket — first-class actions on your
              own data, not generic HTTP calls.
            </Capability>
          </Reveal>
          <Reveal delay={120}>
            <Capability icon={<Container className="size-4" />} title="Real containers, not just prompts">
              An agent node runs one ephemeral container per job — probe a URL, run a check, execute a command. A
              process, not a prompt.
            </Capability>
          </Reveal>
          <Reveal delay={180}>
            <Capability icon={<GitBranch className="size-4" />} title="Branch on judgment">
              Fork on an AI classification — risk, topic, sentiment — so the easy half resolves itself and the hard half
              reaches a human.
            </Capability>
          </Reveal>
        </div>
      </Section>
    </div>
  );
}

// ── 4 · AI answers + customer context — the contact-intelligence shot ─────────
export function Answers() {
  return (
    <Section id="answers">
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="order-2 lg:order-1">
          <Reveal>
            <ProductShot
              src="/shots/contact-light.png"
              alt="A contact profile — Noola reads the account and says it out loud: a power user on the free plan, 41 services, $0 MRR, flagged as an expansion opportunity"
            />
          </Reveal>
        </div>
        <div className="order-1 lg:order-2">
          <Reveal><Eyebrow>AI answers · Copilot</Eyebrow></Reveal>
          <Reveal delay={70}>
            <h2 className="display-xl mt-4">Every answer knows who's asking.</h2>
          </Reveal>
          <Reveal delay={130}>
            <p className="lead mt-5">
              Noola drafts from your own docs, code, and resolved threads — with citations and a confidence score — and
              reads the account before it replies. A power user on the free plan and a churning enterprise get different
              treatment, automatically.
            </p>
          </Reveal>
          <div className="mt-8 flex flex-col gap-4">
            <Reveal delay={80}>
              <Capability icon={<BookOpen className="size-4" />} title="Shows its sources">
                Every draft cites the docs, changelog entries, and past threads it drew from — no black-box answers.
              </Capability>
            </Reveal>
            <Reveal delay={140}>
              <Capability icon={<ShieldCheck className="size-4" />} title="Confidence-gated">
                Above the bar it answers in-thread; below it, a human gets the draft. It never posts a guess.
              </Capability>
            </Reveal>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ── 5 · Channels — every channel at parity ────────────────────────────────────
type ChannelCard = { ch: ChannelKey; body: string };
const CHANNEL_CARDS: ChannelCard[] = [
  { ch: "discord", body: "Thread = ticket. Reactions triage, roles map to identity, answers post back to the channel." },
  { ch: "email", body: "Full threading, attachments, CC — a real ESP behind a driver seam." },
  { ch: "slack", body: "An answer-bot in-channel; escalate to a human thread on demand." },
  { ch: "widget", body: "Streaming AI answers, markdown, attachments both directions." },
  { ch: "telegram", body: "Self-serve connect. Same person, same inbox." },
  { ch: "whatsapp", body: "Self-serve connect. Same person, same inbox." },
  { ch: "api", body: "REST v1 + OpenAPI, and an MCP server your own agents can call." },
];

export function Channels() {
  return (
    <Section id="channels">
      <div className="max-w-2xl">
        <Reveal><Eyebrow>Every channel</Eyebrow></Reveal>
        <Reveal delay={70}><h2 className="display-xl mt-4">Seven doors. One conversation.</h2></Reveal>
        <Reveal delay={130}>
          <p className="lead mt-5">
            No channel is a second-class citizen. Same inbox, same AI, same automations — wherever the message starts.
            New channels plug into the same seam.
          </p>
        </Reveal>
      </div>
      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CHANNEL_CARDS.map((c, i) => (
          <Reveal key={c.ch} delay={i * 40}>
            <div className="flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong">
              <div className="flex items-center gap-2.5">
                <span
                  className="grid size-9 place-items-center rounded-lg"
                  style={{ background: `color-mix(in oklab, ${CHANNEL[c.ch].color} 14%, white)`, color: CHANNEL[c.ch].color }}
                >
                  <ChannelGlyph channel={c.ch} className="size-4" />
                </span>
                <span className="display-m">{CHANNEL[c.ch].label}</span>
              </div>
              <p className="text-[0.9rem] leading-relaxed text-muted-foreground">{c.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

// ── 6 · Developers / Enterprise ───────────────────────────────────────────────
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
    <div className="border-t border-border bg-well">
      <Section id="developers">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Reveal><Eyebrow>Built for engineers</Eyebrow></Reveal>
            <Reveal delay={70}><h2 className="display-xl mt-4">An API for everything the UI does.</h2></Reveal>
            <Reveal delay={130}>
              <p className="lead mt-5">
                Streaming answers included. Bring your own model key; call it from your own agents over MCP.
              </p>
            </Reveal>
            <Reveal delay={160} className="mt-8">
              <div className="overflow-hidden rounded-xl border border-border-strong bg-graphite text-[#e9e8e3] shadow-lg">
                <div className="flex items-center gap-1.5 border-b border-white/10 px-4 py-2.5">
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="size-2.5 rounded-full bg-white/15" />
                  <span className="mono ml-1 text-[0.62rem] text-white/40">ask.sh</span>
                </div>
                <pre className="mono overflow-x-auto px-4 py-4 text-[0.72rem] leading-relaxed">
                  <span className="text-white/45"># stream an answer from your own knowledge</span>
                  {"\n"}
                  <span className="text-[#7a99b8]">curl</span> -N https://api.noola.dev/public/ask/stream \{"\n"}
                  {"  "}-H <span className="text-[#4fb08d]">"authorization: Bearer $NOOLA_KEY"</span> \{"\n"}
                  {"  "}-d <span className="text-[#4fb08d]">{`'{"query":"how do webhook retries work?"}'`}</span>
                  {"\n\n"}
                  <span className="text-white/45"># ← server-sent tokens, with citations</span>
                  {"\n"}
                  <span className="text-[#e0912b]">event:</span> token{"   "}
                  <span className="text-[#e0912b]">data:</span> "Failed deliveries retry with"{"\n"}
                  <span className="text-[#e0912b]">event:</span> source{"  "}
                  <span className="text-[#e0912b]">data:</span> {`{"title":"docs/webhooks.md"}`}
                  {"\n"}
                  <span className="text-[#e0912b]">event:</span> done{"   "}
                  <span className="text-[#e0912b]">data:</span> {`{"confidence":0.94,"resolved":true}`}
                </pre>
              </div>
            </Reveal>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
              {["API v1 + OpenAPI", "TypeScript SDK", "MCP server", "Webhooks · retries + DLQ"].map((x) => (
                <span key={x} className="inline-flex items-center gap-1.5 text-[0.85rem] text-muted-foreground">
                  <Check className="size-3.5 text-success" /> {x}
                </span>
              ))}
            </div>
          </div>

          <Reveal delay={160}>
            <div className="rounded-xl border border-border bg-surface p-7 sm:p-8">
              <div className="eyebrow flex items-center gap-2 text-muted-foreground">
                <ShieldCheck className="size-3.5 text-success" /> Enterprise-ready
              </div>
              <ul className="mt-5 flex flex-col divide-y divide-border">
                {ENTERPRISE.map((e) => (
                  <li key={e} className="flex items-center gap-3 py-3 text-[0.95rem]">
                    <Check className="size-4 shrink-0 text-success" />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </Section>
    </div>
  );
}

// ── 7 · Pricing — honest early access ─────────────────────────────────────────
const INCLUDED = [
  "Every channel — Discord, email, Slack, widget, Telegram, WhatsApp",
  "Agent Studio + the container runner",
  "AI answers & Copilot (bring your own model key)",
  "SSO, SCIM, 2FA, audit log, GDPR tools",
  "API v1, OpenAPI, SDK & MCP server",
];

export function Pricing() {
  return (
    <Section id="pricing">
      <div className="max-w-2xl">
        <Reveal><Eyebrow>Pricing</Eyebrow></Reveal>
        <Reveal delay={70}><h2 className="display-xl mt-4">Free while we're in beta.</h2></Reveal>
        <Reveal delay={130}>
          <p className="lead mt-5">
            Noola is early and built in the open. Self-serve, omnichannel, bring your own model key. Pricing lands at
            GA — until then, running the whole thing costs nothing.
          </p>
        </Reveal>
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Reveal>
          <div className="relative overflow-hidden rounded-2xl border border-border-strong bg-surface p-7 shadow-sm sm:p-9">
            <div className="flex items-baseline justify-between">
              <div className="eyebrow text-primary">Early access</div>
              <span className="ping inline-grid size-2 place-items-center rounded-full bg-primary" />
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="display-xl">Free</span>
              <span className="text-[0.9rem] text-muted-foreground">during beta</span>
            </div>
            <ul className="mt-7 grid gap-3">
              {INCLUDED.map((x) => (
                <li key={x} className="flex items-start gap-2.5 text-[0.92rem]">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" />
                  <span className="text-muted-foreground">{x}</span>
                </li>
              ))}
            </ul>
            <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "solid", size: "lg" }), "mt-8 w-full")}>
              See the live demo
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="flex h-full flex-col justify-center gap-4 rounded-2xl border border-border bg-well p-7 sm:p-9">
            <Quote className="size-5 text-faint" />
            <p className="text-[1.05rem] font-medium leading-relaxed tracking-tight">
              We'd rather earn the conversation about price than invent one today.
            </p>
            <p className="text-[0.9rem] leading-relaxed text-muted-foreground">
              Higher volumes, dedicated routing, and a promote-to-production path arrive with general availability.
            </p>
            <a href="#developers" className={cn(buttonVariants({ variant: "outline" }), "w-fit")}>
              See what's built
              <ArrowDown className="size-4" />
            </a>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

// ── 8 · Final CTA ─────────────────────────────────────────────────────────────
export function FinalCta() {
  return (
    <Section className="text-center">
      <Reveal className="mx-auto flex max-w-2xl flex-col items-center">
        <span className="ping mb-8 inline-grid size-2.5 place-items-center rounded-full bg-primary" />
        <h2 className="display-xl">Bring every channel into one conversation.</h2>
        <p className="lead mt-5">Wire up a channel — or all of them — watch the repeatable half resolve itself, and keep the receipts.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "solid", size: "lg" }))}>
            See the live demo
            <ArrowUpRight className="size-4" />
          </a>
          <a href="#top" className={cn(buttonVariants({ variant: "ghost", size: "lg" }))}>Back to the top</a>
        </div>
      </Reveal>
    </Section>
  );
}
