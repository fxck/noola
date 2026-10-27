import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Wordmark } from "./NoolaMark";
import { buttonVariants } from "./ui/button";
import { cn } from "../lib/utils";
import { DEMO_URL, NAV_LINKS } from "../lib/links";

// Sticky nav — transparent over the hero, settling into a hairline + frosted ground on scroll.
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled ? "border-b border-border bg-background/80 backdrop-blur-xl" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5 sm:px-8">
        <a href="#top" className="shrink-0 rounded-md" aria-label="Noola — home">
          <Wordmark />
        </a>
        <nav className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[0.9rem] text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a href={DEMO_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "solid", size: "sm" }))}>
            See the live demo
            <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}
