import {
  Clock,
  Code2,
  CornerUpLeft,
  FlaskConical,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  Send,
  Slack,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Discord's brand mark, inlined (lucide has no Discord icon). */
export function DiscordGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 127.14 96.36" fill="currentColor" className={cn("size-3 shrink-0", className)} aria-hidden>
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

/** Per-channel glyphs — the marker is only meaningful if each channel actually
 *  looks different (an omnichannel thread marks WHICH channel each turn used). */
const CHANNEL_ICONS: Record<string, LucideIcon> = {
  email: Mail,
  widget: MessageSquare,
  chat: MessageSquare,
  telegram: Send,
  whatsapp: Phone,
  slack: Slack,
  sms: MessageCircle,
  api: Code2,
  synthetic: FlaskConical,
};

/** Chip-free channel marker for list rows (STRUCTURE.md §4): a tiny muted
 *  icon, label only in the tooltip. The rail names the channel in words. */
export function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  if (channel === "discord") {
    return (
      <span title={label} aria-label={label} className="inline-flex shrink-0">
        <DiscordGlyph className={cn("size-3.5 text-muted-foreground/70", className)} />
      </span>
    );
  }
  const Icon = CHANNEL_ICONS[channel] ?? MessageSquare;
  return (
    <span title={label} aria-label={label} className="inline-flex shrink-0">
      <Icon className={cn("size-3.5 text-muted-foreground/70", className)} />
    </span>
  );
}

/** The channel a ticket came in on. */
export function ChannelBadge({ channel }: { channel: string }) {
  if (channel === "discord") {
    return (
      <Badge variant="outline" className="text-[#5865F2] dark:text-[#8b93f5]">
        <DiscordGlyph />
        Discord
      </Badge>
    );
  }
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  return (
    <Badge variant="outline">
      <MessageSquare />
      {label}
    </Badge>
  );
}

/** Whose turn it is — the platform's core signal. 'us' = a customer is waiting on
 *  us (draw the eye, amber); 'customer' = we've replied and are waiting on them. */
export function WhoseTurnBadge({ turn }: { turn: "us" | "customer" | null }) {
  if (turn === "us") {
    return (
      <Badge variant="warning">
        <CornerUpLeft />
        Needs reply
      </Badge>
    );
  }
  if (turn === "customer") {
    return (
      <Badge variant="muted">
        <Clock />
        Waiting
      </Badge>
    );
  }
  return null;
}
