import { Hero } from "./components/hero";
import { Problem, Inbox, Studio, Answers, Channels, Developers, Pricing, FinalCta } from "./components/sections";

// The marketing home. Order is the argument: show the product, name the pain (dark interlude),
// then the two flagships in turn — the omnichannel inbox (one conversation across every channel)
// and Agent Studio (visual automation that acts on the platform) — prove the AI reads context,
// enumerate the channels at parity, satisfy the engineer, be honest about price, close the loop.
export function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <Inbox />
      <Studio />
      <Answers />
      <Channels />
      <Developers />
      <Pricing />
      <FinalCta />
    </>
  );
}
