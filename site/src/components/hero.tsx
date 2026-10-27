import { ArrowUpRight, ArrowDown } from "lucide-react";
import { ProductShot, ChannelGlyph, CHANNEL, type ChannelKey } from "./mocks";
import { buttonVariants } from "./ui/button";
import { Reveal } from "./reveal";
import { cn } from "../lib/utils";
import { DEMO_URL } from "../lib/links";

// No channel leads — the row reads as a set of equals (parity is the point).
const HERO_CHANNELS: ChannelKey[] = ["discord", "email", "slack", "widget", "telegram", "whatsapp", "api"];

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 hairline-grid opacity-40" aria-hidden="true" />
      <div className="relative mx-auto max-w-6xl px-5 pb-4 pt-16 sm:px-8 sm:pt-24">
        <div className="max-w-3xl">
          <Reveal>
            <div className="eyebrow flex items-center gap-2.5 text-muted-foreground">
              <span className="ping inline-grid size-1.5 place-items-center rounded-full bg-primary" />
              The omnichannel support platform
            </div>
          </Reveal>
          <Reveal delay={70}>
            <h1 className="display-hero mt-6">
              One inbox for every channel.
              <br className="hidden sm:block" /> One canvas to <span className="text-primary">automate the rest</span>.
            </h1>
          </Reveal>
          <Reveal delay={140}>
            <p className="lead mt-6 max-w-2xl">
              Discord, email, Slack, your in-app widget — every conversation lands in one place, keyed to the person and
              not the channel. Noola answers the repeatable half with cited sources, and automates the rest on a visual
              canvas that acts on your actual support desk.
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

        {/* the product, large — the real inbox as a lit exhibit, shown whole (no crop) */}
        <Reveal delay={180} className="mt-14 sm:mt-16">
          <ProductShot
            src="/shots/inbox-dark.png"
            alt="The Noola inbox — one queue across every channel, a conversation open with an AI-suggested reply, and the customer's context in the details rail"
            priority
          />
        </Reveal>

        {/* honest trust line — the real channels at parity + the real posture, no fake logos */}
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
