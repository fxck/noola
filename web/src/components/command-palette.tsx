import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CornerDownLeft,
  FilePlus2,
  FileStack,
  Inbox,
  ListChecks,
  LogOut,
  Megaphone,
  MessageSquare,
  MessageSquareReply,
  Search,
  SlidersHorizontal,
  UserPlus,
  Users,
  Webhook,
} from "lucide-react";
import { useAuth } from "@/auth/auth";
import { fetchContacts } from "@/lib/contacts";
import { searchArticles } from "@/lib/kb";
import { initials, searchTickets } from "@/lib/tickets";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// ── Open bus ────────────────────────────────────────────────────────────────
// The palette self-manages its open state (global ⌘K shortcut, below). This tiny
// module-level pub/sub lets any trigger — e.g. the header search button — pop it
// open without prop-drilling a setter through AppShell.
const openListeners = new Set<() => void>();
/** Open the ⌘K command palette from anywhere (header trigger, etc.). */
export function openCommandPalette(): void {
  openListeners.forEach((fn) => fn());
}

type IconType = ComponentType<{ className?: string }>;
type Group = "Go to" | "Contacts" | "Articles" | "Tickets" | "Actions";

interface CommandItem {
  id: string;
  group: Group;
  title: string;
  subtitle?: string;
  icon?: IconType;
  /** Initials avatar (contacts) rendered instead of an icon. */
  avatar?: string;
  run: () => void;
}

// Static nav targets. `as const` keeps `to` as literal route paths so TanStack's
// typed navigate() accepts them.
const NAV_TARGETS = [
  { label: "Inbox", to: "/", icon: Inbox, keywords: "tickets threads" },
  { label: "Knowledge Base", to: "/kb", icon: BookOpen, keywords: "kb articles docs" },
  { label: "Sources", to: "/sources", icon: FileStack, keywords: "documents" },
  { label: "Customers", to: "/contacts", icon: Users, keywords: "people contacts companies accounts" },
  { label: "Broadcasts", to: "/broadcasts", icon: Megaphone, keywords: "campaigns" },
  { label: "Approvals", to: "/queue", icon: ListChecks, keywords: "queue drafts approval jobs" },
  { label: "Model settings", to: "/settings/model", icon: SlidersHorizontal, keywords: "settings ai" },
  {
    label: "Autoreply settings",
    to: "/settings/autoreply",
    icon: MessageSquareReply,
    keywords: "settings automation",
  },
  { label: "Webhook settings", to: "/settings/webhooks", icon: Webhook, keywords: "settings integrations" },
] as const;

export function CommandPalette() {
  const navigate = useNavigate();
  const { logout } = useAuth();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // Debounced query for the async (contacts/articles/tickets) searches.
  const [debounced, setDebounced] = useState("");
  const [contacts, setContacts] = useState<{ id: string; name: string; sub?: string }[]>([]);
  const [articles, setArticles] = useState<{ id: string; title: string }[]>([]);
  const [tickets, setTickets] = useState<{ id: string; subject: string; status: string }[]>([]);
  const [searching, setSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const close = useCallback(() => setOpen(false), []);

  // Global shortcut + open-bus subscription (always mounted, independent of open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    const openNow = () => setOpen(true);
    openListeners.add(openNow);
    return () => {
      document.removeEventListener("keydown", onKey);
      openListeners.delete(openNow);
    };
  }, []);

  // Reset on open/close; focus the input and lock background scroll while open.
  useEffect(() => {
    if (!open) {
      setContacts([]);
      setArticles([]);
      setTickets([]);
      setDebounced("");
      return;
    }
    setQuery("");
    setActiveIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Debounce the query (~200ms).
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(id);
  }, [query]);

  // Async search — contacts / articles / tickets. allSettled so one failure never
  // kills the others (and no unhandled rejections in the console).
  useEffect(() => {
    if (!open) return;
    const q = debounced.trim();
    if (!q) {
      setContacts([]);
      setArticles([]);
      setTickets([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    Promise.allSettled([fetchContacts({ q, limit: 6 }), searchArticles(q), searchTickets(q)]).then(
      ([c, a, t]) => {
        if (cancelled) return;
        setContacts(
          c.status === "fulfilled"
            ? c.value.contacts.slice(0, 6).map((x) => ({
                id: x.id,
                name: x.name || x.email || "Unnamed contact",
                sub: x.email || x.company || undefined,
              }))
            : [],
        );
        setArticles(
          a.status === "fulfilled" ? a.value.slice(0, 6).map((x) => ({ id: x.id, title: x.title })) : [],
        );
        setTickets(
          t.status === "fulfilled"
            ? t.value.slice(0, 6).map((x) => ({ id: x.id, subject: x.subject || "(no subject)", status: x.status }))
            : [],
        );
        setSearching(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [debounced, open]);

  // Flat, group-ordered list of the currently-visible items (drives keyboard nav).
  const items = useMemo<CommandItem[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (text: string) => !q || text.toLowerCase().includes(q);
    const out: CommandItem[] = [];

    for (const t of NAV_TARGETS) {
      if (matches(`${t.label} ${t.keywords}`)) {
        out.push({
          id: `nav:${t.to}`,
          group: "Go to",
          title: t.label,
          icon: t.icon,
          run: () => void navigate({ to: t.to }),
        });
      }
    }
    for (const c of contacts) {
      out.push({
        id: `contact:${c.id}`,
        group: "Contacts",
        title: c.name,
        subtitle: c.sub,
        avatar: initials(c.name),
        run: () => void navigate({ to: "/contacts/$contactId", params: { contactId: c.id } }),
      });
    }
    for (const a of articles) {
      out.push({
        id: `article:${a.id}`,
        group: "Articles",
        title: a.title,
        icon: BookOpen,
        run: () => void navigate({ to: "/kb/$articleId", params: { articleId: a.id } }),
      });
    }
    for (const tk of tickets) {
      out.push({
        id: `ticket:${tk.id}`,
        group: "Tickets",
        title: tk.subject,
        subtitle: tk.status,
        icon: MessageSquare,
        run: () => void navigate({ to: "/", search: { ticket: tk.id } }),
      });
    }
    const actions: { id: string; label: string; icon: IconType; keywords: string; run: () => void }[] = [
      { id: "new-contact", label: "New contact", icon: UserPlus, keywords: "create add person", run: () => void navigate({ to: "/contacts", search: { create: true } }) },
      { id: "new-article", label: "New article", icon: FilePlus2, keywords: "create add kb knowledge", run: () => void navigate({ to: "/kb/new" }) },
      { id: "sign-out", label: "Sign out", icon: LogOut, keywords: "logout log out exit session", run: () => void logout() },
    ];
    for (const ac of actions) {
      if (matches(`${ac.label} ${ac.keywords}`)) {
        out.push({ id: `action:${ac.id}`, group: "Actions", title: ac.label, icon: ac.icon, run: ac.run });
      }
    }
    return out;
  }, [query, contacts, articles, tickets, navigate, logout]);

  // Highlight starts at the top after each keystroke; stays in range as results shift.
  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    setActiveIndex((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)));
  }, [items.length]);

  // Keep the active row visible.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, items.length]);

  const activate = useCallback(
    (item: CommandItem) => {
      close();
      item.run();
    },
    [close],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) activate(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="presentation">
      <div className="motion-overlay absolute inset-0 bg-black/40" aria-hidden onClick={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="motion-pop absolute left-1/2 top-[12vh] w-[calc(100%-2rem)] max-w-xl origin-center -translate-x-1/2 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
      >
        <div className="flex items-center gap-2.5 border-b px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="command-palette-list"
            aria-activedescendant={items.length ? `command-opt-${activeIndex}` : undefined}
            aria-label="Search commands, contacts, and articles"
            placeholder="Search or jump to…"
            autoComplete="off"
            spellCheck={false}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searching && <Spinner className="size-4 shrink-0" />}
        </div>

        <div
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="max-h-[22rem] overflow-y-auto overscroll-contain p-1.5"
        >
          {items.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              {query.trim() ? `No results for “${query.trim()}”` : "Type to search"}
            </div>
          ) : (
            items.map((item, i) => {
              const Icon = item.icon;
              const showHeader = i === 0 || items[i - 1].group !== item.group;
              return (
                <Fragment key={item.id}>
                  {showHeader && (
                    <div className="px-2.5 pb-1 pt-3 text-micro font-medium uppercase tracking-wider text-muted-foreground first:pt-1">
                      {item.group}
                    </div>
                  )}
                  <div
                    id={`command-opt-${i}`}
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseMove={() => setActiveIndex(i)}
                    onClick={() => activate(item)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm",
                      i === activeIndex ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    {item.avatar !== undefined ? (
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-micro font-semibold text-secondary-foreground">
                        {item.avatar}
                      </span>
                    ) : Icon ? (
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.subtitle && (
                      <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    )}
                  </div>
                </Fragment>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-3 border-t px-3.5 py-2 text-micro text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5">
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>
            open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>
              <ArrowUp className="size-3" />
            </Kbd>
            <Kbd>
              <ArrowDown className="size-3" />
            </Kbd>
            navigate
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>esc</Kbd>
            close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-sans text-micro font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
