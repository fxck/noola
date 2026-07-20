import { Mail, MessageSquare, Send, Phone, Terminal, Hash } from "lucide-react";
import { cn } from "../lib/utils";

// ── Channels ────────────────────────────────────────────────────────────────
export type ChannelKey = "discord" | "email" | "widget" | "slack" | "telegram" | "whatsapp" | "api";

export const CHANNEL: Record<ChannelKey, { label: string; color: string }> = {
  discord: { label: "Discord", color: "var(--c-discord)" },
  email: { label: "Email", color: "var(--c-email)" },
  widget: { label: "In-app widget", color: "var(--c-widget)" },
  slack: { label: "Slack", color: "var(--c-slack)" },
  telegram: { label: "Telegram", color: "var(--c-telegram)" },
  whatsapp: { label: "WhatsApp", color: "var(--c-whatsapp)" },
  api: { label: "API · MCP", color: "var(--c-api)" },
};

export function ChannelGlyph({ channel, className }: { channel: ChannelKey; className?: string }) {
  const c = cn("size-4", className);
  switch (channel) {
    case "discord":
      return (
        <svg viewBox="0 0 24 24" className={c} fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      );
    case "email":
      return <Mail className={c} />;
    case "widget":
      return <MessageSquare className={c} />;
    case "slack":
      return <Hash className={c} />;
    case "telegram":
      return <Send className={c} />;
    case "whatsapp":
      return <Phone className={c} />;
    case "api":
      return <Terminal className={c} />;
  }
}

// ── The product itself — real screenshots, framed as lit exhibits ─────────────
// `ratio` turns the frame into a fixed-aspect window that crops to a region of a
// wide shot (via object-position); omit it to show the whole screenshot.
export function ProductShot({
  src,
  alt,
  ratio,
  position,
  priority,
  className,
}: {
  src: string;
  alt: string;
  ratio?: string;
  position?: string;
  priority?: boolean;
  className?: string;
}) {
  if (ratio) {
    return (
      <figure className={cn("shot-window", className)} style={{ aspectRatio: ratio }}>
        <img src={src} alt={alt} style={position ? { objectPosition: position } : undefined} loading={priority ? "eager" : "lazy"} />
      </figure>
    );
  }
  return (
    <figure className={cn("shot", className)}>
      <img src={src} alt={alt} loading={priority ? "eager" : "lazy"} />
    </figure>
  );
}
