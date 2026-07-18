import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Search,
  Pencil,
  Trash2,
  Download,
  ShieldX,
  AlertTriangle,
  Loader2,
  Camera,
  ArrowLeft,
  MoreHorizontal,
  GitMerge,
  Activity,
  AtSign,
  Mail,
  MailX,
  MessagesSquare,
  SlidersHorizontal,
} from "lucide-react";
import {
  type Contact,
  type ContactHistory,
  type ContactEvent,
  type ContactIdentity,
  fetchContact,
  fetchContactHistory,
  fetchContacts,
  fetchContactEvents,
  fetchContactIdentities,
  mergeContact,
  setContactSubscription,
  exportContactData,
  isContactsUnavailable,
} from "@/lib/contacts";
import { useAuth } from "@/auth/auth";
import { fetchCompanies } from "@/lib/companies";
import { relativeTime } from "@/lib/tickets";
import { ChannelIcon } from "@/components/inbox/badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Avatar } from "@/components/ui/avatar";
import { toast } from "@/components/ui/toaster";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { FactRow, RailSection } from "@/components/ui/rail";
import { avatarSrc, uploadAvatar } from "@/lib/avatar-upload";
import { type LoadState } from "@/components/contacts/contact-lib";
import { cn } from "@/lib/utils";

const abs = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
};

// The contact detail surface, on the entity-page pattern (STRUCTURE.md §3/§6):
// h-12 pane header (back · avatar · name · quiet email · actions), activity in
// the main column, and a facts rail built on the shared rail primitives — the
// same language the inbox context rail speaks. Below xl the rail's content
// stacks at the end of the main column instead.
export function ContactDetail({
  contactId,
  initial,
  nerd,
  onBack,
  onEdit,
  onDelete,
  onErase,
}: {
  contactId: string;
  initial: Contact | null;
  nerd: boolean;
  onBack: () => void;
  onEdit: (c: Contact) => void;
  onDelete: (c: Contact) => void;
  onErase?: (c: Contact) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const [contact, setContact] = useState<Contact | null>(initial);

  async function exportData(c: Contact) {
    try {
      const blob = await exportContactData(c.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contact-${(c.email || c.name || c.id).replace(/[^\w.@-]+/g, "_")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Exported the contact's data.");
    } catch {
      toast.error("Couldn't export that contact.");
    }
  }

  const [history, setHistory] = useState<ContactHistory | null>(null);
  const [historyState, setHistoryState] = useState<LoadState>("ok");
  const [identities, setIdentities] = useState<ContactIdentity[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [merging, setMerging] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setNotFound(false);
    // Fresh contact (attributes may have changed since the list loaded).
    void (async () => {
      try {
        const fresh = await fetchContact(contactId);
        if (live) setContact(fresh);
      } catch (e) {
        if (live && (e as { status?: number }).status === 404) setNotFound(true);
      }
    })();
    // History is best-effort — degrade gracefully if the endpoint is absent.
    setHistory(null);
    setHistoryState("ok");
    void (async () => {
      try {
        const h = await fetchContactHistory(contactId);
        if (live) setHistory(h);
      } catch (e) {
        if (!live) return;
        setHistoryState(isContactsUnavailable(e) ? "unavailable" : "error");
      }
    })();
    // The channels this contact is known on (omnichannel) — best-effort.
    setIdentities([]);
    void (async () => {
      try {
        const ids = await fetchContactIdentities(contactId);
        if (live) setIdentities(ids);
      } catch {
        /* older server — the section simply doesn't render */
      }
    })();
    return () => {
      live = false;
    };
  }, [contactId]);

  // Resolve the contact's company NAME to an account id so the Company fact can
  // link to the company page. Best-effort — renders as plain text until matched.
  const companyName = contact?.company?.trim() ?? "";
  const [companyId, setCompanyId] = useState<string | null>(null);
  useEffect(() => {
    setCompanyId(null);
    if (!companyName) return;
    let live = true;
    fetchCompanies({ q: companyName, limit: 50 })
      .then(({ companies }) => {
        if (!live) return;
        const hit = companies.find((co) => co.name.toLowerCase() === companyName.toLowerCase());
        if (hit) setCompanyId(hit.id);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [companyName]);

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploadingAvatar(true);
    try {
      await uploadAvatar(file, contactId);
      // Re-fetch so the fresh avatar_url (and any server-side changes) land.
      setContact(await fetchContact(contactId));
      toast.success("Photo updated.");
    } catch (err) {
      toast.error((err as Error).message || "Couldn't upload that photo. Please try again.");
    } finally {
      setUploadingAvatar(false);
    }
  }

  // The manual opt-out path — an agent flips this when a contact asks to stop
  // (or resume) receiving broadcasts. The server owns the timestamp; the fresh
  // row it returns replaces our copy.
  const [togglingSubscription, setTogglingSubscription] = useState(false);
  async function toggleSubscription() {
    if (!contact) return;
    const unsubscribe = !contact.unsubscribed_at;
    setTogglingSubscription(true);
    try {
      setContact(await setContactSubscription(contactId, unsubscribe));
      toast.success(unsubscribe ? "Unsubscribed from marketing." : "Resubscribed to marketing.");
    } catch {
      toast.error("Couldn't update the subscription. Please try again.");
    } finally {
      setTogglingSubscription(false);
    }
  }

  async function doMerge(dropId: string) {
    try {
      const updated = await mergeContact(contactId, dropId);
      setContact(updated);
      setMerging(false);
      setHistory(await fetchContactHistory(contactId));
      toast.success("Contacts merged.");
    } catch {
      toast.error("Couldn't merge those contacts. Please try again.");
    }
  }

  if (notFound) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <AlertTriangle className="size-7 opacity-40" />
          <p className="text-sm">This contact no longer exists.</p>
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to contacts
          </Button>
        </div>
      </div>
    );
  }

  const c = contact;
  if (!c) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── pane header (§3): back · avatar · name · quiet email · actions ── */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Link
          to="/contacts"
          aria-label="Back to contacts"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <span className="relative shrink-0">
          <Avatar name={c.name || c.email} image={avatarSrc(c.avatar_url)} className="size-6 text-micro" />
          {c.online && (
            <span
              title="Active now"
              className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-background bg-success"
            />
          )}
        </span>
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">
          {c.name || c.email || "Anonymous visitor"}
        </h1>
        {c.online ? (
          <span className="hidden shrink-0 text-xs font-medium text-success sm:block">Active now</span>
        ) : c.last_seen_at ? (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
            Last seen {relativeTime(c.last_seen_at)}
          </span>
        ) : null}
        {c.email && (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{c.email}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => onEdit(c)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Menu
            trigger={(open, toggle) => (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                aria-label="More actions"
                aria-expanded={open}
                onClick={toggle}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          >
            <MenuItem icon={GitMerge} label="Merge a duplicate…" onSelect={() => setMerging(true)} />
            <MenuItem
              icon={uploadingAvatar ? Loader2 : Camera}
              label={uploadingAvatar ? "Uploading photo…" : "Change photo…"}
              disabled={uploadingAvatar}
              onSelect={() => avatarInputRef.current?.click()}
            />
            <MenuItem
              icon={c.unsubscribed_at ? Mail : MailX}
              label={c.unsubscribed_at ? "Resubscribe to marketing" : "Unsubscribe from marketing"}
              disabled={togglingSubscription}
              onSelect={() => void toggleSubscription()}
            />
            <MenuSeparator />
            <MenuItem icon={Download} label="Export data (GDPR)…" onSelect={() => void exportData(c)} />
            <MenuItem icon={Trash2} label="Delete contact…" destructive onSelect={() => onDelete(c)} />
            {isAdmin && onErase && (
              <MenuItem icon={ShieldX} label="Erase everything (GDPR)…" destructive onSelect={() => onErase(c)} />
            )}
          </Menu>
        </div>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void onPickAvatar(e)}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── main column: the activity the contact generates ── */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-5">
            {nerd && (
              <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-micro tabular-nums text-muted-foreground/80">
                <span>id {c.id}</span>
                {c.external_id && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span>ext {c.external_id}</span>
                  </>
                )}
                <span className="text-muted-foreground/40">·</span>
                <span>added {relativeTime(c.created_at)}</span>
              </div>
            )}

            {/* custom-data events timeline */}
            <EventTimeline contactId={contactId} />

            {/* below xl the rail is hidden — the same facts stack here instead */}
            <div className="mt-8 xl:hidden">
              <ContactFacts
                contact={c}
                companyId={companyId}
                history={history}
                historyState={historyState}
                identities={identities}
              />
            </div>
          </div>
        </main>

        {/* ── facts rail (§6) ── */}
        <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-border/60 xl:block">
          <ContactFacts
            contact={c}
            companyId={companyId}
            history={history}
            historyState={historyState}
            identities={identities}
          />
        </aside>
      </div>

      <MergeContactDialog
        open={merging}
        keepId={contactId}
        onCancel={() => setMerging(false)}
        onMerge={(dropId) => void doMerge(dropId)}
      />
    </div>
  );
}

// The rail content — pinned facts, then collapsible sections. Rendered twice
// (rail at xl+, stacked at the end of the main column below), so all fetching
// stays in the parent.
function ContactFacts({
  contact: c,
  companyId,
  history,
  historyState,
  identities,
}: {
  contact: Contact;
  companyId: string | null;
  history: ContactHistory | null;
  historyState: LoadState;
  identities: ContactIdentity[];
}) {
  const attrEntries = Object.entries(c.attributes ?? {});
  const planEntry = attrEntries.find(([k]) => k.toLowerCase() === "plan");
  // Plan is pinned above — it leaves the Attributes section (a fact renders once).
  const attrs = attrEntries.filter(([k]) => k.toLowerCase() !== "plan");
  const latest = history?.tickets[0];
  const lastActivity = latest ? latest.updated_at || latest.created_at : null;

  return (
    <>
      <div className="px-4 py-3">
        <dl className="flex flex-col">
          {c.email && (
            <FactRow label="Email">
              <a
                href={`mailto:${c.email}`}
                className="min-w-0 truncate underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {c.email}
              </a>
            </FactRow>
          )}
          {c.company && (
            <FactRow label="Company">
              {companyId ? (
                <Link
                  to="/companies/$companyId"
                  params={{ companyId }}
                  className="min-w-0 truncate underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Open company"
                >
                  {c.company}
                </Link>
              ) : (
                <span className="min-w-0 truncate">{c.company}</span>
              )}
            </FactRow>
          )}
          {planEntry && (
            <FactRow label="Plan">
              <span className="min-w-0 truncate">{planEntry[1]}</span>
            </FactRow>
          )}
          {/* subscribed is the default state — it stays quiet; only the opt-out
              carries weight (agents check this before broadcasting) */}
          <FactRow label="Marketing">
            {c.unsubscribed_at ? (
              <span title={abs(c.unsubscribed_at)}>Unsubscribed {relativeTime(c.unsubscribed_at)}</span>
            ) : (
              <span className="text-muted-foreground">Subscribed</span>
            )}
          </FactRow>
          <FactRow label="Created">
            <span title={abs(c.created_at)}>{relativeTime(c.created_at)}</span>
          </FactRow>
          <FactRow label="Last activity">
            {lastActivity ? <span title={abs(lastActivity)}>{relativeTime(lastActivity)}</span> : "—"}
          </FactRow>
        </dl>
      </div>

      {attrs.length > 0 && (
        <RailSection id="contact.attrs" icon={SlidersHorizontal} title="Attributes" count={attrs.length} defaultOpen>
          <dl className="flex flex-col">
            {attrs.map(([k, v]) => (
              <FactRow key={k} label={k}>
                <span className="min-w-0 truncate" title={String(v)}>
                  {String(v)}
                </span>
              </FactRow>
            ))}
          </dl>
        </RailSection>
      )}

      {identities.length > 0 && (
        <RailSection id="contact.identities" icon={AtSign} title="Identities" count={identities.length}>
          <ul className="flex flex-col">
            {identities.map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-1.5 text-small">
                <ChannelIcon channel={i.channel_type} className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                  title={i.external_id}
                >
                  {i.external_id}
                </span>
              </li>
            ))}
          </ul>
        </RailSection>
      )}

      <RailSection
        id="contact.recent"
        icon={MessagesSquare}
        title="Recent conversations"
        count={history?.tickets.length}
        defaultOpen
      >
        <ConversationList history={history} state={historyState} />
      </RailSection>
    </>
  );
}

// The contact's conversations — status dot + subject + time, each row jumping
// into the inbox. Reuses the page-level history fetch.
function ConversationList({ history, state }: { history: ContactHistory | null; state: LoadState }) {
  if (state === "unavailable")
    return <p className="py-1 text-xs text-muted-foreground/70">Conversation history isn't available on this server yet.</p>;
  if (state === "error")
    return <p className="py-1 text-xs text-muted-foreground/70">Couldn't load conversations.</p>;
  if (history === null) return <p className="py-1 text-xs text-muted-foreground/70">Loading…</p>;
  if (history.tickets.length === 0)
    return <p className="py-1 text-xs text-muted-foreground/70">No conversations yet.</p>;

  return (
    <ul className="-mx-1.5 flex flex-col">
      {history.tickets.map((t) => (
        <li key={t.id}>
          <Link
            to="/"
            search={{ ticket: t.id }}
            className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-small transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                t.status === "closed" ? "bg-muted-foreground/50" : "bg-success",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{t.subject || "(no subject)"}</span>
            <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
              {relativeTime(t.updated_at || t.created_at)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// The contact's activity timeline — custom data events (Wave 5) recorded via the API. Self-fetching,
// best-effort: stays quiet on an older server that lacks the endpoint, empty-states when there are none.
function EventTimeline({ contactId }: { contactId: string }) {
  const [events, setEvents] = useState<ContactEvent[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    setEvents(null);
    setUnavailable(false);
    void (async () => {
      try {
        const e = await fetchContactEvents(contactId);
        if (live) setEvents(e);
      } catch (err) {
        if (live && (err as { status?: number }).status === 404) setUnavailable(true);
        else if (live) setEvents([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [contactId]);

  if (unavailable) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">Activity</h3>
        {events && events.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {events.length} {events.length === 1 ? "event" : "events"}
          </span>
        )}
      </div>
      {events === null ? (
        <div className="grid place-items-center py-6">
          <Spinner />
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed p-6 text-center">
          <Activity className="size-5 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No events yet.</p>
          <p className="text-xs text-muted-foreground/70">
            Track custom events via the API (<code className="rounded bg-muted px-1 py-0.5">POST /public/events</code>).
          </p>
        </div>
      ) : (
        <ol className="relative space-y-3 border-l pl-4">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary/60 ring-4 ring-background" aria-hidden />
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-foreground">{e.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={abs(e.created_at)}>
                  {relativeTime(e.created_at)}
                </span>
              </div>
              {Object.keys(e.metadata ?? {}).length > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {Object.entries(e.metadata).map(([k, v], i) => (
                    <span key={k}>
                      {i > 0 && <span className="text-muted-foreground/40"> · </span>}
                      <span className="font-medium text-foreground/70">{k}</span> {String(v)}
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// Merge dialog — search for a duplicate contact and fold it into the current one (identity
// resolution). The current contact is KEPT; the picked one is merged in and deleted.
function MergeContactDialog({
  open,
  keepId,
  onCancel,
  onMerge,
}: {
  open: boolean;
  keepId: string;
  onCancel: () => void;
  onMerge: (dropId: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) { setQ(""); setResults([]); return; }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    const h = setTimeout(() => {
      setSearching(true);
      fetchContacts({ q: term, limit: 6 })
        .then((r) => setResults(r.contacts.filter((c) => c.id !== keepId)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(h);
  }, [q, open, keepId]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-md rounded-xl border bg-card p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><GitMerge className="size-4" /> Merge a duplicate</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Find the duplicate contact to fold into this one. It will be merged in and removed — this can't be undone.
        </p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts…" className="h-9 pl-8 text-sm" autoFocus />
        </div>
        {searching && <p className="mt-2 flex items-center gap-1 text-micro text-muted-foreground"><Loader2 className="size-3 animate-spin motion-reduce:animate-none" /> Searching…</p>}
        <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onMerge(c.id)}
                className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Avatar name={c.name || c.email} className="size-6 shrink-0 text-micro" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{c.name || "Unnamed"}</span>
                  {c.email && <span className="ml-1 text-muted-foreground">{c.email}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
