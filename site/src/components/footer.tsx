import { ArrowUpRight } from "lucide-react";
import { Wordmark } from "./NoolaMark";
import { DEMO_URL } from "../lib/links";

const COLS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#problem" },
      { label: "AI answers", href: "#answers" },
      { label: "Agent Studio", href: "#studio" },
      { label: "Channels", href: "#channels" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Platform",
    links: [
      { label: "Live demo", href: DEMO_URL, external: true },
      { label: "API & OpenAPI", href: "#developers" },
      { label: "MCP server", href: "#developers" },
      { label: "Enterprise", href: "#developers" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-4 text-small leading-relaxed text-muted-foreground">
            The AI-native support platform for software teams whose users live in Discord. One conversation across
            every channel.
          </p>
          <div className="mono mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[0.66rem] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            All systems operational
          </div>
        </div>

        {COLS.map((col) => (
          <div key={col.title}>
            <div className="eyebrow text-muted-foreground/70">{col.title}</div>
            <ul className="mt-4 flex flex-col gap-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    target={l.external ? "_blank" : undefined}
                    rel={l.external ? "noreferrer" : undefined}
                    className="inline-flex items-center gap-1 text-small text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {l.label}
                    {l.external && <ArrowUpRight className="size-3" />}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 py-5 text-[0.72rem] text-muted-foreground sm:flex-row sm:px-8">
          <span>© {2026} Noola. Built in the open on Zerops.</span>
          <span className="mono text-muted-foreground/70">Signal &amp; Graphite</span>
        </div>
      </div>
    </footer>
  );
}
