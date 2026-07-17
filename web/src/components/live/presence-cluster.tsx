import { useRealtime } from "@/lib/realtime-context";
import type { PresenceUser } from "@/lib/realtime";
import { initials } from "@/lib/tickets";
import { cn } from "@/lib/utils";

/** A single stacked presence avatar with a live-green ring. */
function PresenceAvatar({ user, className }: { user: PresenceUser; className?: string }) {
  return (
    <span
      title={`${user.name} · online`}
      className={cn(
        "grid size-7 place-items-center rounded-full bg-accent text-micro font-semibold text-accent-foreground ring-2 ring-background",
        className,
      )}
    >
      {initials(user.name)}
    </span>
  );
}

/**
 * Tenant-wide "who's here" cluster for the top bar. Small stacked avatars of the
 * other agents currently online (you're excluded). A tiny live dot anchors it.
 * Hidden entirely when you're alone — no clutter, only signal.
 */
export function PresenceCluster({ max = 4 }: { max?: number }) {
  const { others } = useRealtime();
  if (others.length === 0) return null;

  const shown = others.slice(0, max);
  const overflow = others.length - shown.length;
  const names = others.map((o) => o.name).join(", ");

  return (
    <span
      className="hidden items-center pl-1 sm:flex"
      title={`${others.length} other ${others.length === 1 ? "agent" : "agents"} online: ${names}`}
    >
      <span className="flex -space-x-2">
        {shown.map((u) => (
          <PresenceAvatar key={u.user_id} user={u} />
        ))}
        {overflow > 0 && (
          <span className="grid size-7 place-items-center rounded-full bg-muted text-micro font-semibold text-muted-foreground ring-2 ring-background">
            +{overflow}
          </span>
        )}
      </span>
    </span>
  );
}
