import { Hero } from "./components/hero";
import { Problem, Studio, Answers, Channels, Developers, Pricing, FinalCta } from "./components/sections";

// The marketing home. Order is the argument: show the product, name the pain (dark interlude),
// reveal the differentiator (Studio does real work), prove the AI reads context, enumerate the
// channels, satisfy the engineer, be honest about price, then close the loop.
export function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <Studio />
      <Answers />
      <Channels />
      <Developers />
      <Pricing />
      <FinalCta />
    </>
  );
}
