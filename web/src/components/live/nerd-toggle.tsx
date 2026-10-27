import { Terminal } from "lucide-react";
import { useNerdMode } from "@/lib/nerd-mode";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Top-bar toggle for global nerd mode. Off by default; when on, the app's
 * instrument-panel layer (retrieval math, tokens, latency, trace ids, autoreply
 * decisions, RT HUD) becomes visible.
 */
export function NerdToggle() {
  const { nerd, toggle } = useNerdMode();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={nerd ? "Nerd mode: on — hide instrument stats" : "Nerd mode: off — show instrument stats"}
      aria-label="Toggle nerd mode"
      aria-pressed={nerd}
      className={cn(nerd && "text-primary")}
    >
      <Terminal />
    </Button>
  );
}
