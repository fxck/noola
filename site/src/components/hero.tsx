import { ArrowUpRight, ArrowDown } from "lucide-react";
import { ProductShot, ChannelGlyph, CHANNEL, type ChannelKey } from "./mocks";
import { buttonVariants } from "./ui/button";
import { Reveal } from "./reveal";
import { cn } from "../lib/utils";
import { DEMO_URL } from "../lib/links";

const HERO_CHANNELS: ChannelKey[] = ["discord", "email", "slack", "widget", "telegram", "api"];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 hairline-grid opacity-40" aria-hidden="true" />
      <div className="relative mx-auto max-w-6xl px-5 pb-4 pt-16 sm:px-8 sm:pt-24">
        {/* headline block — left-weighted, editorial */}
        <div className="max-w-3xl">
          <Reveal>
            <div className="eyebrow flex items-center gap-2.5 text-muted-foreground">
              <span className="ping inline-grid size-1.5 place-items-center rounded-full bg-primary" />
              Discord-native support platform
            </div>
          </Reveal>
          <Reveal delay={70}>
            <h1 className="display-hero mt-6">
              Your users don't file tickets.
              <br className="hidden sm:block" /> They post in <span className="text-primary">Discord</span>.
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="lead mt-6 max-w-2xl">
              Noola pulls every channel into one inbox, answers the repeatable half with cited sources, and runs the
              rest through automations that actually do the work — not chatbots that deflect.
            </p>
          </Reveal>
          <Reveal delay={200}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "solid", size: "lg" }))}>
                See the live demo
                <ArrowUpRight className="size-4" />
              </a>
              <a href="#inbox" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
                How it works
                <ArrowDown className="size-4" />
              </a>
            </div>
          </Reveal>
        </div>

        {/* the product, large — the real inbox as a lit exhibit */}
        <Reveal delay={180} className="mt-14 sm:mt-16">
          <ProductShot
            src="/shots/inbox.png"
            alt="The Noola inbox — one thread across Discord, email and the in-app widget, with an AI-drafted reply"
            priority
            ratio="16/9"
            position="left top"
          />
        </Reveal>

        {/* honest trust line — the real channels + the real posture, no fake logos */}
        <Reveal delay={120}>
          <div className="mt-8 flex flex-col items-start gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {HERO_CHANNELS.map((ch) => (
                <span key={ch} className="inline-flex items-center gap-1.5 text-[0.85rem] text-muted-foreground">
                  <span style={{ color: CHANNEL[ch].color }}>
                    <ChannelGlyph channel={ch} className="size-3.5" />
                  </span>
                  {CHANNEL[ch].label.replace("In-app ", "")}
                </span>
              ))}
            </div>
            <p className="mono shrink-0 text-[0.7rem] text-faint">open · self-serve · built in the open on Zerops</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
