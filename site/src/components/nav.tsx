import { useEffect, useState } from "react";
import { Sun, Moon, ArrowUpRight } from "lucide-react";
import { Wordmark } from "./NoolaMark";
import { Button, buttonVariants } from "./ui/button";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { DEMO_URL, NAV_LINKS } from "../lib/links";

// Sticky nav — a bare wordmark on the canvas until you scroll, then a hairline + backdrop blur
// settle in. One amber CTA (the live demo); everything else is quiet.
export function Nav() {
  const { theme, toggle } = useTheme();
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
        scrolled ? "border-b border-border/70 bg-background/80 backdrop-blur-md" : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
        <a href="#top" className="shrink-0 rounded-md" aria-label="Noola — home">
          <Wordmark />
        </a>

        <nav className="ml-2 hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-small text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "signal", size: "sm" }))}
          >
            See the live demo
            <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}
