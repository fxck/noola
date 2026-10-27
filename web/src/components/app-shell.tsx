import { useEffect, useState, type ReactNode } from "react";
import { LogOut, Menu, Moon, Sun } from "lucide-react";
import { useAuth } from "@/auth/auth";
import { CommandPalette } from "@/components/command-palette";
import { PresenceCluster } from "@/components/live/presence-cluster";
import { RtStatusPill } from "@/components/live/rt-status-pill";
import { RtHud } from "@/components/live/rt-hud";
import { NerdToggle } from "@/components/live/nerd-toggle";
import { NavRail, MobileNavDrawer, type NavKey } from "@/components/nav-rail";
import { AutopilotChip } from "@/components/queue/job-row";
import { Avatar } from "@/components/ui/avatar";
import { NoolaMark } from "@/components/noola-mark";
import { Button } from "@/components/ui/button";
import { avatarSrc } from "@/lib/avatar-upload";
import { useJobs } from "@/lib/jobs-context";
import { isDarkNow, setThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Light/dark toggle — an explicit choice that persists (boot defaults to the OS scheme). */
function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(isDarkNow);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-7 text-muted-foreground", className)}
      onClick={() => {
        setThemePref(dark ? "light" : "dark");
        setDark(!dark);
      }}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </Button>
  );
}

// The one app frame — STRUCTURE.md §1–2. There is NO global top bar: the nav
// rail owns the global utilities (search/⌘K up top; live status, user and
// Settings at the bottom), and everything right of the rail is a quiet canvas
// holding ONE rounded content surface per route. Routes render INTO the
// surface; split surfaces divide themselves with vertical hairlines only.
export type { NavKey };

// Per-section browser-tab titles so the tab reflects where you are, not a static "noola".
const NAV_TITLES: Partial<Record<NavKey, string>> = {
  inbox: "Inbox",
  studio: "Studio",
  kb: "Knowledge Base",
  sources: "Sources",
  customers: "Customers",
  broadcasts: "Broadcasts",
  features: "Feature requests",
  analytics: "Analytics",
  settings: "Settings",
};

export function AppShell({
  active,
  scroll = "page",
  frame = "surface",
  onRefresh,
  refreshing,
  actions,
  belowHeader,
  children,
}: {
  active: NavKey;
  /** "page" = the surface scrolls as one document; "pane" = children manage
   *  their own internal scrolling (split surfaces like the inbox). */
  scroll?: "page" | "pane";
  /** "surface" = wrap children in the single rounded content surface.
   *  "canvas" = children lay out their own floating panels directly on the
   *  canvas (Intercom-style multi-card surfaces like the inbox). */
  frame?: "surface" | "canvas";
  /** @deprecated STRUCTURE.md killed the refresh button (realtime app). Accepted so
   *  legacy callers compile until the propagation sweep removes them. */
  onRefresh?: () => void;
  /** @deprecated no global bar to render into. */
  refreshing?: boolean;
  /** @deprecated no global bar to render into. */
  actions?: ReactNode;
  /** @deprecated no global bar to render into. */
  belowHeader?: ReactNode;
  children: ReactNode;
}) {
  // Legacy slots intentionally unused — the frame has no top bar to put them in.
  void onRefresh;
  void refreshing;
  void actions;
  void belowHeader;

  const { user, logout } = useAuth();
  const { activeCount: jobsActive } = useJobs();
  const [mobileNav, setMobileNav] = useState(false);

  // Per-route document title so the browser tab reflects the current section, not a static "noola".
  useEffect(() => {
    const label = NAV_TITLES[active];
    document.title = label ? `${label} · noola` : "noola";
  }, [active]);

  // Rail footer — the global cluster the old top bar used to hold.
  const railFooter = (collapsed: boolean) =>
    collapsed ? (
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <ThemeToggle />
        <Avatar name={user?.name} image={avatarSrc(user?.avatarUrl)} className="size-7 text-micro" />
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={logout}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="size-3.5" />
        </Button>
      </div>
    ) : (
      <div className="space-y-1 px-2 pb-1">
        {jobsActive > 0 && (
          <div className="px-1">
            <AutopilotChip activeCount={jobsActive} />
          </div>
        )}
        {/* nerd HUD — its own wrap-safe row, only when nerd mode is on */}
        <RtHud className="px-1" />
        {/* status row: signal + presence left, quiet utility toggles right */}
        <div className="flex min-w-0 items-center gap-1 px-1">
          <RtStatusPill />
          <PresenceCluster />
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <NerdToggle />
            <ThemeToggle />
          </span>
        </div>
        <div className="flex items-center gap-2 px-1 py-1">
          <Avatar name={user?.name} image={avatarSrc(user?.avatarUrl)} className="size-7 text-micro" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-small font-medium">{user?.name}</div>
            <div className="text-micro capitalize text-muted-foreground">{user?.role}</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="size-3.5" />
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex h-dvh bg-muted">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <NavRail active={active} footer={railFooter} />
      <MobileNavDrawer
        active={active}
        open={mobileNav}
        onClose={() => setMobileNav(false)}
        footer={railFooter}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only chrome strip — desktop has zero top bar. */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-3 lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1"
            onClick={() => setMobileNav(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
          <NoolaMark className="size-5" />
          <span className="text-sm font-semibold tracking-tight">noola</span>
          <div className="ml-auto">
            <Avatar name={user?.name} image={avatarSrc(user?.avatarUrl)} className="size-7 text-micro" />
          </div>
        </div>

        <main id="main-content" className="flex min-h-0 flex-1 flex-col p-2">
          {frame === "surface" ? (
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col rounded-xl border bg-card shadow-sm",
                scroll === "page" ? "overflow-y-auto" : "overflow-hidden",
              )}
            >
              {children}
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
