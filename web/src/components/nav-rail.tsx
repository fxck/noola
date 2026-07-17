import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Inbox as InboxIcon,
  Waypoints,
  BookOpen,
  FileStack,
  Megaphone,
  Lightbulb,
  Users,
  BarChart3,
  Search,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { NoolaMark } from "@/components/noola-mark";
import { openCommandPalette } from "@/components/command-palette";
import { QueueBadge } from "@/components/queue/queue-badge";
import { cn } from "@/lib/utils";

// The nav rail sits directly ON the workspace canvas (STRUCTURE.md §1) — no
// background, no right border. It owns the global utilities the old top bar
// held: search/⌘K under the brand, and a `footer` cluster (live status, user)
// supplied by the AppShell, with Settings pinned last.
export type NavKey =
  | "inbox"
  | "studio"
  | "kb"
  | "sources"
  | "customers"
  | "features"
  | "broadcasts"
  | "analytics"
  | "settings";

type NavEntry = { key: NavKey; to: string; label: string; icon: LucideIcon; badge?: "queue" };

// Grouped by what the operator is *doing*, not alphabetically — the four bands
// mirror the north-star's console / knowledge / growth / insight registers.
const NAV_GROUPS: { heading: string; items: NavEntry[] }[] = [
  {
    heading: "Work",
    items: [
      { key: "inbox", to: "/", label: "Inbox", icon: InboxIcon, badge: "queue" },
      { key: "studio", to: "/studio", label: "Studio", icon: Waypoints },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      { key: "kb", to: "/kb", label: "Knowledge Base", icon: BookOpen },
      { key: "sources", to: "/sources", label: "Sources", icon: FileStack },
    ],
  },
  {
    heading: "Customers",
    items: [
      { key: "customers", to: "/contacts", label: "Customers", icon: Users },
      { key: "broadcasts", to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
      { key: "features", to: "/features", label: "Feature requests", icon: Lightbulb },
    ],
  },
  {
    heading: "Insight",
    items: [
      { key: "analytics", to: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
];

const SETTINGS_ITEM: NavEntry = {
  key: "settings",
  // Land on the Settings overview — a scannable map of every area — not an arbitrary inner page.
  to: "/settings",
  label: "Settings",
  icon: SettingsIcon,
};

function NavItem({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavEntry;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md py-1.5 text-small transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "justify-center px-0" : "px-2.5",
        active
          ? "bg-card font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
      )}
    >
      {/* Unmistakable active marker in a vertical rail — an accent bar at the edge. */}
      {active && (
        <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" aria-hidden />
      )}
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="min-w-0 flex-1 truncate whitespace-nowrap">{item.label}</span>}
      {!collapsed && item.badge === "queue" && <QueueBadge />}
    </Link>
  );
}

/** The rail's inner content — reused verbatim by the desktop rail and the mobile drawer. */
export function NavRailContent({
  active,
  collapsed = false,
  onNavigate,
  onToggleCollapse,
  footer,
}: {
  active: NavKey;
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Desktop rail passes this — renders the collapse control INSIDE the rail
   *  (header when expanded, own row when collapsed). Mobile drawer omits it. */
  onToggleCollapse?: () => void;
  /** Global cluster (live status, user block) rendered above Settings. */
  footer?: (collapsed: boolean) => ReactNode;
}) {
  const collapseBtn = onToggleCollapse && (
    <button
      type="button"
      onClick={onToggleCollapse}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-card/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex h-12 shrink-0 items-center gap-2",
          collapsed ? "justify-center px-0" : "pl-4 pr-2",
        )}
      >
        <Link
          to="/"
          aria-label="Noola — home"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            !collapsed && "min-w-0 flex-1",
          )}
        >
          <NoolaMark />
          {!collapsed && <span className="text-sm font-semibold tracking-tight">noola</span>}
        </Link>
        {!collapsed && collapseBtn}
      </div>
      {collapsed && collapseBtn && <div className="flex justify-center pb-1">{collapseBtn}</div>}

      {/* Global search — the ⌘K affordance the old top bar carried. */}
      <div className={cn("shrink-0 pb-1", collapsed ? "px-2" : "px-2")}>
        <button
          type="button"
          onClick={openCommandPalette}
          title="Search — ⌘K"
          aria-label="Open command palette"
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md py-1.5 text-small text-muted-foreground transition-colors hover:bg-card/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            collapsed ? "justify-center px-0" : "px-2.5",
          )}
        >
          <Search className="size-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="rounded border bg-card px-1 font-sans text-micro font-medium leading-4 text-muted-foreground">
                ⌘K
              </kbd>
            </>
          )}
        </button>
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-2" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="space-y-0.5">
            {!collapsed && (
              <p className="px-2.5 pb-1 text-micro font-medium uppercase tracking-wide text-muted-foreground/70">
                {group.heading}
              </p>
            )}
            {group.items.map((item) => (
              <NavItem
                key={item.key}
                item={item}
                active={active === item.key}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-1 pt-1">
        {footer?.(collapsed)}
        <div className="px-2 pb-2">
          <NavItem
            item={SETTINGS_ITEM}
            active={active === "settings"}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </div>
  );
}

const COLLAPSE_KEY = "noola.nav.collapsed";

/** The persistent desktop rail (lg+). Collapses to an icon rail; choice persists. */
export function NavRail({
  active,
  footer,
}: {
  active: NavKey;
  footer?: (collapsed: boolean) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* private mode — collapse just won't persist */
      }
      return next;
    });

  return (
    <aside
      className={cn(
        "relative hidden shrink-0 flex-col transition-[width] duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none lg:flex",
        collapsed ? "w-14" : "w-56",
      )}
    >
      <NavRailContent
        active={active}
        collapsed={collapsed}
        onToggleCollapse={toggle}
        footer={footer}
      />
    </aside>
  );
}

/** Slide-in drawer for the same rail on phones/tablets (below lg). */
export function MobileNavDrawer({
  active,
  open,
  onClose,
  footer,
}: {
  active: NavKey;
  open: boolean;
  onClose: () => void;
  footer?: (collapsed: boolean) => ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div
        className="motion-overlay absolute inset-0 bg-foreground/30 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div className="motion-drawer-left absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-muted shadow-xl">
        <NavRailContent active={active} onNavigate={onClose} footer={footer} />
      </div>
    </div>
  );
}
