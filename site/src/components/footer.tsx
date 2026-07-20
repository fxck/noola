import { ArrowUpRight } from "lucide-react";
import { Wordmark } from "./NoolaMark";
import { DEMO_URL } from "../lib/links";

const COLS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Omnichannel inbox", href: "#inbox" },
      { label: "Agent Studio", href: "#studio" },
      { label: "AI answers", href: "#answers" },
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
    <footer className="border-t border-border bg-well">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 sm:px-8 md:grid-cols-[1.6fr_1fr_1fr]">
        <div className="max-w-xs">
          <Wordmark />
          <p className="mt-4 text-[0.9rem] leading-relaxed text-muted-foreground">
            The omnichannel support platform for software teams. One conversation across every channel — with automation
            that does the work.
          </p>
          <div className="mono mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-[0.68rem] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success" />
            All systems operational
          </div>
        </div>
        {COLS.map((col) => (
          <div key={col.title}>
            <div className="eyebrow text-faint">{col.title}</div>
            <ul className="mt-4 flex flex-col gap-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    target={l.external ? "_blank" : undefined}
                    rel={l.external ? "noreferrer" : undefined}
                    className="inline-flex items-center gap-1 text-[0.9rem] text-muted-foreground transition-colors hover:text-foreground"
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
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 py-5 text-[0.72rem] text-faint sm:flex-row sm:px-8">
          <span>© {2026} Noola. Built in the open on Zerops.</span>
          <span className="mono">Signal &amp; Graphite, in daylight</span>
        </div>
      </div>
    </footer>
  );
}
