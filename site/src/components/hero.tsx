import { ArrowUpRight, ArrowDown } from "lucide-react";
import { InboxMock, ChannelGlyph, CHANNEL, type ChannelKey } from "./mocks";
import { buttonVariants } from "./ui/button";
import { Reveal } from "./reveal";
import { cn } from "../lib/utils";
import { DEMO_URL } from "../lib/links";

const HERO_CHANNELS: ChannelKey[] = ["discord", "email", "slack", "widget", "telegram", "api"];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* faint grid wash, fading out downward — texture, not decoration */}
      <div
        className="pointer-events-none absolute inset-0 grid-lines opacity-[0.35]"
        style={{ maskImage: "linear-gradient(to bottom, black, transparent 70%)", WebkitMaskImage: "linear-gradient(to bottom, black, transparent 70%)" }}
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1.02fr_1fr] lg:gap-10 lg:py-24">
        {/* ── left: the argument ── */}
        <div className="max-w-xl">
          <Reveal>
            <div className="eyebrow flex items-center gap-2 text-muted-foreground">
              <span className="relative grid size-2 place-items-center">
                <span className="sonar-ring" style={{ animationDelay: "0s" }} />
                <span className="sonar-ring" style={{ animationDelay: "1s" }} />
                <span className="size-1.5 rounded-full bg-primary" />
              </span>
              Support platform · Discord-native
            </div>
          </Reveal>

          <Reveal delay={60}>
            <h1 className="display-xl mt-5">Support that reads the signal.</h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="lead mt-5 text-muted-foreground">
              One inbox for Discord, email, Slack, and your app. An AI that resolves the repeatable half and routes the
              rest — with the receipts to prove it.
            </p>
          </Reveal>

          <Reveal delay={180}>
            <div className="mt-8 flex flex-wrap items-center gap-2.5">
              <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "signal", size: "lg" }))}>
                See the live demo
                <ArrowUpRight className="size-4" />
              </a>
              <a href="#problem" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                How it works
                <ArrowDown className="size-4" />
              </a>
            </div>
          </Reveal>

          <Reveal delay={240}>
            <div className="mt-9 border-t border-border/60 pt-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {HERO_CHANNELS.map((ch) => (
                  <span key={ch} className="inline-flex items-center gap-1.5 text-small text-muted-foreground">
                    <span style={{ color: CHANNEL[ch].color }}>
                      <ChannelGlyph channel={ch} className="size-3.5" />
                    </span>
                    {CHANNEL[ch].short}
                  </span>
                ))}
              </div>
              <p className="mono mt-3 text-[0.68rem] text-muted-foreground/80">
                Open · self-serve · built in the open on Zerops
              </p>
            </div>
          </Reveal>
        </div>

        {/* ── right: the product itself ── */}
        <Reveal delay={160} className="relative">
          {/* the sonar — the one decorative signature, behind the product */}
          <div className="pointer-events-none absolute -right-6 -top-10 size-40 opacity-60" aria-hidden="true">
            <span className="sonar-ring" style={{ animationDelay: "0s" }} />
            <span className="sonar-ring" style={{ animationDelay: "1.5s" }} />
          </div>
          <div className="relative">
            <InboxMock />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
