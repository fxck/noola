import { Hero } from "./components/hero";
import { Problem, Answers, Studio, Channels, Developers, Pricing, FinalCta } from "./components/sections";

// The marketing home. Order is the argument: show the product, name the problem, prove the AI,
// reveal the differentiator (Studio), enumerate the channels, satisfy the engineer, be honest about
// price, then close the loop. Each section earns its scroll.
export function Home() {
  return (
    <>
      <Hero />
      <Problem />
      <Answers />
      <Studio />
      <Channels />
      <Developers />
      <Pricing />
      <FinalCta />
    </>
  );
}
