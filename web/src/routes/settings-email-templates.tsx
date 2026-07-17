import { useEffect, useMemo, useRef, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeft,
  Copy,
  LayoutTemplate,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Reply,
  Trash2,
  X,
} from "lucide-react";
import {
  type EmailTemplate,
  type EmailTemplateTokens,
  type SocialLink,
  fetchEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  previewEmailTemplate,
} from "@/lib/email-templates";
import type { ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/tickets";
import { SettingsRail } from "@/components/settings-rail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuItem, MenuSeparator, PopoverSelect } from "@/components/ui/menu";
import { EmailPreview } from "@/components/email-preview";
import { FormDialog } from "@/components/ui/form-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "@/components/ui/toaster";

// Email template designer — Settings ▸ Email templates. A list of templates
// (two read-only built-ins + tenant customs), and for the selected one a
// grouped-controls rail on the LEFT with a dominant server-rendered live
// preview on the RIGHT (the server owns email HTML — the client never
// approximates it).

// Debounce for the live preview as tokens are edited — matches the broadcast
// compose reach preview cadence.
const PREVIEW_DEBOUNCE_MS = 400;

/** Every token present — the designer edits a fully-resolved set so each
 *  control always has a concrete value to show. */
type ResolvedTokens = Required<EmailTemplateTokens>;

// The branded built-in's defaults, mirrored client-side ONLY as a fallback for
// the instant before GET /email-templates returns (the live "branded" row —
// always first, always full — is the real source once loaded).
const BRANDED_FALLBACK: ResolvedTokens = {
  bodyBackground: "#f4f4f5",
  cardBackground: "#ffffff",
  borderColor: "#e4e4e7",
  borderRadius: 12,
  showCard: true,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  textColor: "#18181b",
  mutedColor: "#71717a",
  linkColor: "#e8a33d",
  h1Size: 20,
  h2Size: 17,
  paragraphSize: 15,
  smallSize: 12,
  subjectSize: 22,
  showSubject: true,
  wordmark: "Noola",
  logoUrl: "",
  footerText: "You received this because you're a contact of this workspace.",
  socialLinks: [],
};

// Curated font choices — each stores its FULL stack string in the token (email
// clients get a stack, not a keyword). Matching back is by signature substring
// so a stack saved by an older build (or the server default) still selects.
const FONT_OPTIONS: { key: string; label: string; stack: string }[] = [
  { key: "system", label: "System default", stack: BRANDED_FALLBACK.fontFamily },
  { key: "georgia", label: "Georgia (serif)", stack: "Georgia, 'Times New Roman', Times, serif" },
  { key: "menlo", label: "Menlo (mono)", stack: "Menlo, Consolas, 'Liberation Mono', monospace" },
  { key: "arial", label: "Arial", stack: "Arial, Helvetica, sans-serif" },
];

function fontKeyFor(stack: string): string {
  const s = stack.toLowerCase();
  if (s.includes("georgia") || s.includes("times")) return "georgia";
  if (s.includes("menlo") || s.includes("consolas") || s.includes("monospace")) return "menlo";
  if (s.startsWith("arial")) return "arial";
  return "system";
}

// #rgb / #rgba / #rrggbb / #rrggbbaa — the server's accepted color grammar.
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Native <input type=color> only speaks #rrggbb — normalize (expand shorthand,
 *  drop alpha) so the swatch tracks whatever valid hex the text field holds. */
function toPickerHex(v: string): string {
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}/.test(s)) return s.slice(0, 7);
  if (/^#[0-9a-f]{3,4}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return "#000000";
}

const routeApi = getRouteApi("/settings/email-templates");

export function SettingsEmailTemplatesPage() {
  const { template: selectedId } = routeApi.useSearch();
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<EmailTemplate | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleting, setDeleting] = useState<EmailTemplate | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useRef(async () => {
    setStatus("loading");
    try {
      setTemplates(await fetchEmailTemplates());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }).current;

  useEffect(() => {
    void load();
  }, [load]);

  // Quiet refetch (no loading state) — used after a save that moves the
  // reply flag, so the PREVIOUS holder's indicator clears (the server
  // un-flags it; only a fresh list shows that).
  const refresh = useRef(async () => {
    try {
      setTemplates(await fetchEmailTemplates());
    } catch {
      // Non-fatal — the save itself succeeded; the list catches up next load.
    }
  }).current;

  const open = (id: string | null) =>
    void navigate({ to: "/settings/email-templates", search: id ? { template: id } : {} });

  // The live branded row (always first, full token set) is the source of the
  // defaults custom templates' partial tokens resolve against.
  const brandedDefaults = useMemo<ResolvedTokens>(() => {
    const branded = templates.find((t) => t.id === "branded");
    return { ...BRANDED_FALLBACK, ...(branded?.tokens ?? {}) };
  }, [templates]);

  const selected = selectedId ? templates.find((t) => t.id === selectedId) : undefined;

  // A stale deep link (?template=<deleted id>) falls back to the list.
  useEffect(() => {
    if (status === "ready" && selectedId && !selected) {
      toast.error("That template no longer exists.");
      open(null);
    }
    // `open` is stable enough (navigate identity); depending on it would refire needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, selectedId, selected]);

  async function duplicate(t: EmailTemplate) {
    try {
      // A copy carries the source's RESOLVED tokens so it looks identical until edited
      // (a built-in's set is already full; customs resolve against branded defaults).
      const tokens: EmailTemplateTokens = { ...brandedDefaults, ...t.tokens };
      const copy = await createEmailTemplate({ name: `${t.name} copy`, tokens });
      setTemplates((list) => [...list, copy]);
      toast.success(`Created “${copy.name}” — it's yours to edit.`);
      open(copy.id);
    } catch {
      toast.error("Couldn't duplicate the template.");
    }
  }

  async function createNew() {
    setCreating(true);
    try {
      // No tokens — the server seeds the branded defaults.
      const t = await createEmailTemplate({ name: "Untitled template" });
      setTemplates((list) => [...list, t]);
      toast.success("Template created.");
      open(t.id);
    } catch {
      toast.error("Couldn't create a template.");
    } finally {
      setCreating(false);
    }
  }

  function openRename(t: EmailTemplate) {
    setRenaming(t);
    setRenameValue(t.name);
  }

  async function saveRename() {
    if (!renaming || !renameValue.trim()) return;
    setRenameBusy(true);
    try {
      const saved = await updateEmailTemplate(renaming.id, { name: renameValue.trim() });
      setTemplates((list) => list.map((x) => (x.id === saved.id ? saved : x)));
      toast.success("Template renamed.");
      setRenaming(null);
    } catch {
      toast.error("Couldn't rename the template.");
    } finally {
      setRenameBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await deleteEmailTemplate(deleting.id);
      setTemplates((list) => list.filter((x) => x.id !== deleting.id));
      if (selectedId === deleting.id) open(null);
      toast.success("Template deleted.");
      setDeleting(null);
    } catch {
      toast.error("Couldn't delete the template.");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <SettingsRail active="email-templates" />

        {selected ? (
          <TemplateDesigner
            key={selected.id}
            template={selected}
            defaults={brandedDefaults}
            onBack={() => open(null)}
            onSaved={(t) => setTemplates((list) => list.map((x) => (x.id === t.id ? t : x)))}
            onRefresh={() => void refresh()}
            onDuplicate={() => void duplicate(selected)}
          />
        ) : (
          <div className="min-w-0 flex-1 overflow-y-auto">
            <header className="flex h-12 shrink-0 items-center gap-2 px-6">
              <h1 className="text-sm font-semibold tracking-tight">Email templates</h1>
              {status === "ready" && (
                <span className="text-sm tabular-nums text-muted-foreground">{templates.length}</span>
              )}
              {status === "ready" && (
                <Button
                  size="sm"
                  variant="brand"
                  className="ml-auto gap-1.5"
                  onClick={() => void createNew()}
                  disabled={creating}
                >
                  {creating ? (
                    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Plus className="size-4" />
                  )}
                  New template
                </Button>
              )}
            </header>
            <p className="px-6 text-small text-muted-foreground">
              The stationery your outbound email wears. Broadcasts pick a template at compose time,
              and one custom template can frame ticket replies; built-ins are read-only — duplicate
              one to make it yours.
            </p>
            <div className="max-w-3xl px-6 pb-10 pt-4">
              {status === "loading" ? (
                <RowsSkeleton rows={4} />
              ) : status === "error" ? (
                <ErrorState
                  title="Couldn't load your email templates"
                  onRetry={() => void load()}
                />
              ) : (
                <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border bg-card shadow-sm">
                  {templates.map((t) => (
                    <TemplateRow
                      key={t.id}
                      template={t}
                      onOpen={() => open(t.id)}
                      onDuplicate={() => void duplicate(t)}
                      onRename={() => openRename(t)}
                      onDelete={() => setDeleting(t)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      <FormDialog
        open={renaming !== null}
        title="Rename template"
        description="The name is what broadcast compose shows in its template picker."
        onClose={() => setRenaming(null)}
        onSubmit={() => void saveRename()}
        submitLabel={renameBusy ? "Saving…" : "Rename"}
        submitDisabled={!renameValue.trim()}
        busy={renameBusy}
      >
        <div className="space-y-1.5">
          <Label htmlFor="tpl-name">Name</Label>
          <Input
            id="tpl-name"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={120}
          />
        </div>
      </FormDialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this template?"
        message={
          deleting
            ? `“${deleting.name}” will be removed. Broadcasts already sent with it are unaffected.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function TemplateRow({
  template: t,
  onOpen,
  onDuplicate,
  onRename,
  onDelete,
}: {
  template: EmailTemplate;
  onOpen: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
      <LayoutTemplate className="size-4 shrink-0 text-muted-foreground" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{t.name}</span>
          {/* Quiet marker on THE reply-frame holder (one per tenant; never a built-in). */}
          {t.useForReplies && (
            <span title="Frames ticket replies" className="shrink-0 text-muted-foreground">
              <Reply aria-label="Frames ticket replies" className="size-3.5" />
            </span>
          )}
        </span>
        <span className="block text-xs text-muted-foreground">
          {t.builtin ? "Built-in" : t.updated_at ? `Updated ${relativeTime(t.updated_at)}` : "Custom"}
        </span>
      </button>
      <Menu
        trigger={(open, toggle) => (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            aria-label={`Actions for ${t.name}`}
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        <MenuItem icon={Pencil} label={t.builtin ? "View" : "Open"} onSelect={onOpen} />
        <MenuItem
          icon={Copy}
          label={t.builtin ? "Duplicate to customize" : "Duplicate"}
          onSelect={onDuplicate}
        />
        {!t.builtin && (
          <>
            <MenuItem icon={Pencil} label="Rename…" onSelect={onRename} />
            <MenuSeparator />
            <MenuItem icon={Trash2} label="Delete…" destructive onSelect={onDelete} />
          </>
        )}
      </Menu>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Designer — grouped controls rail (left) + live server-rendered preview (right).
// Edits are local; Save PATCHes, Discard resets. Built-ins render read-only.
// ─────────────────────────────────────────────────────────────────────────────
function TemplateDesigner({
  template,
  defaults,
  onBack,
  onSaved,
  onRefresh,
  onDuplicate,
}: {
  template: EmailTemplate;
  defaults: ResolvedTokens;
  onBack: () => void;
  onSaved: (t: EmailTemplate) => void;
  /** Quiet full-list refetch — needed when the reply flag moves, so the
   *  previous holder's indicator clears. */
  onRefresh: () => void;
  onDuplicate: () => void;
}) {
  const readOnly = template.builtin;

  // The designer edits the RESOLVED set (partial tokens merged over branded
  // defaults) so every control has a value; the server tolerates full sets.
  const [base, setBase] = useState<ResolvedTokens>(() => ({
    ...defaults,
    ...template.tokens,
  }));
  const [draft, setDraft] = useState<ResolvedTokens>(base);
  // "Use for ticket replies" is a top-level flag, not a token, but it rides
  // the same draft → Save model as everything else in the rail.
  const [baseReplies, setBaseReplies] = useState(template.useForReplies === true);
  const [replies, setReplies] = useState(baseReplies);
  const [saving, setSaving] = useState(false);
  const repliesDirty = !readOnly && replies !== baseReplies;
  const dirty = repliesDirty || (!readOnly && JSON.stringify(draft) !== JSON.stringify(base));

  const set = <K extends keyof ResolvedTokens>(k: K, v: ResolvedTokens[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // What actually ships (preview + save): half-typed social rows are still
  // being built — they neither render nor persist.
  const payload = useMemo<EmailTemplateTokens>(
    () => ({
      ...draft,
      socialLinks: draft.socialLinks.filter((l) => l.label.trim() !== "" && l.url.trim() !== ""),
    }),
    [draft],
  );

  // Live preview — debounced POST of the CURRENT tokens; the last html stays up
  // (dimmed) while the next renders, so the pane never flashes empty.
  const [html, setHtml] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setRefreshing(true);
    const t = setTimeout(async () => {
      try {
        const p = await previewEmailTemplate({ tokens: payload });
        if (live) {
          setHtml(p.html);
          setPreviewFailed(false);
        }
      } catch {
        if (live) setPreviewFailed(true);
      } finally {
        if (live) setRefreshing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [payload]);

  async function save() {
    setSaving(true);
    try {
      const saved = await updateEmailTemplate(template.id, {
        tokens: payload,
        // Only send the flag when it actually changed — flagging ON moves it
        // here (the server un-flags the previous holder); OFF just clears it.
        ...(repliesDirty ? { useForReplies: replies } : {}),
      });
      setBase(draft);
      setBaseReplies(replies);
      onSaved(saved);
      if (repliesDirty) {
        // The flag moved — refetch so the previous holder's indicator clears.
        onRefresh();
        toast.success(
          replies
            ? "Saved — ticket replies now wear this design."
            : "Saved — replies are back to the stock personal look.",
        );
      } else {
        toast.success("Template saved.");
      }
    } catch (e) {
      toast.error((e as ApiError).detail ?? "Couldn't save the template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── header (h-12, §3): back · name · quiet state · save cluster ──── */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          onClick={onBack}
          aria-label="Back to templates"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <h1 className="min-w-0 truncate text-sm font-semibold tracking-tight">{template.name}</h1>
        {readOnly && <span className="shrink-0 text-xs text-muted-foreground">Built-in</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {readOnly ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onDuplicate}>
              <Copy className="size-3.5" /> Duplicate to customize
            </Button>
          ) : (
            <>
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              {dirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setDraft(base);
                    setReplies(baseReplies);
                  }}
                  disabled={saving}
                >
                  Discard
                </Button>
              )}
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => void save()}
                disabled={!dirty || saving}
              >
                {saving && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
                Save
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── controls rail — grouped, scrollable. fieldset[disabled] turns the
            whole rail read-only for built-ins in one move. ─────────────────── */}
        <fieldset
          disabled={readOnly}
          className="w-80 min-w-0 shrink-0 space-y-6 overflow-y-auto border-r border-border/60 px-4 pb-8 pt-3"
        >
          {readOnly && (
            <p className="text-small text-muted-foreground">
              Built-in template — duplicate to customize.
            </p>
          )}

          <Group title="Frame">
            <ToggleRow
              label="Show card"
              checked={draft.showCard}
              onChange={(v) => set("showCard", v)}
            />
            <ColorRow
              label="Body background"
              value={draft.bodyBackground}
              onChange={(v) => set("bodyBackground", v)}
            />
            <ColorRow
              label="Card background"
              value={draft.cardBackground}
              onChange={(v) => set("cardBackground", v)}
            />
            <ColorRow
              label="Border color"
              value={draft.borderColor}
              onChange={(v) => set("borderColor", v)}
            />
            <NumberRow
              label="Corner radius"
              value={draft.borderRadius}
              min={0}
              max={32}
              onChange={(v) => set("borderRadius", v)}
            />
          </Group>

          <Group title="Typography">
            <div className="flex items-center justify-between gap-3">
              <span className="text-small text-muted-foreground">Font</span>
              <PopoverSelect
                value={fontKeyFor(draft.fontFamily)}
                options={FONT_OPTIONS.map((f) => ({ value: f.key, label: f.label }))}
                onChange={(k) => {
                  const f = FONT_OPTIONS.find((x) => x.key === k);
                  if (f) set("fontFamily", f.stack);
                }}
              />
            </div>
            <ColorRow
              label="Text color"
              value={draft.textColor}
              onChange={(v) => set("textColor", v)}
            />
            <ColorRow
              label="Muted color"
              value={draft.mutedColor}
              onChange={(v) => set("mutedColor", v)}
            />
            <ColorRow
              label="Link & accent"
              value={draft.linkColor}
              onChange={(v) => set("linkColor", v)}
            />
          </Group>

          <Group title="Sizes">
            <NumberRow
              label="Subject"
              value={draft.subjectSize}
              min={14}
              max={40}
              onChange={(v) => set("subjectSize", v)}
            />
            <NumberRow
              label="Heading 1"
              value={draft.h1Size}
              min={12}
              max={40}
              onChange={(v) => set("h1Size", v)}
            />
            <NumberRow
              label="Heading 2"
              value={draft.h2Size}
              min={11}
              max={32}
              onChange={(v) => set("h2Size", v)}
            />
            <NumberRow
              label="Paragraph"
              value={draft.paragraphSize}
              min={11}
              max={24}
              onChange={(v) => set("paragraphSize", v)}
            />
            <NumberRow
              label="Small text"
              value={draft.smallSize}
              min={9}
              max={18}
              onChange={(v) => set("smallSize", v)}
            />
          </Group>

          <Group title="Header">
            <ToggleRow
              label="Show subject in body"
              checked={draft.showSubject}
              onChange={(v) => set("showSubject", v)}
            />
            <div className="space-y-1.5">
              <Label htmlFor="tpl-wordmark" className="text-xs">
                Wordmark
              </Label>
              <Input
                id="tpl-wordmark"
                value={draft.wordmark}
                onChange={(e) => set("wordmark", e.target.value)}
                maxLength={60}
                placeholder="Your workspace name"
                className="h-8 text-xs"
              />
              <p className="text-xs text-muted-foreground">Leave it empty to hide the header.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-logo" className="text-xs">
                Logo URL
              </Label>
              <Input
                id="tpl-logo"
                type="url"
                value={draft.logoUrl}
                onChange={(e) => set("logoUrl", e.target.value)}
                placeholder="https://…"
                spellCheck={false}
                className="h-8 text-xs"
              />
              <p className="text-xs text-muted-foreground">
                When set, the image replaces the wordmark text.
              </p>
            </div>
          </Group>

          <Group title="Footer">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-footer" className="text-xs">
                Footer text
              </Label>
              <Textarea
                id="tpl-footer"
                value={draft.footerText}
                onChange={(e) => set("footerText", e.target.value)}
                maxLength={500}
                rows={3}
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Social links</Label>
              <SocialLinksEditor
                links={draft.socialLinks}
                onChange={(l) => set("socialLinks", l)}
              />
            </div>
          </Group>

          {/* Usage, not design — custom templates only (built-ins can't hold
              the flag). Rides the same Save as the tokens above. */}
          {!readOnly && (
            <Group title="Ticket replies">
              <ToggleRow
                label="Use for ticket replies"
                checked={replies}
                onChange={setReplies}
              />
              <p className="text-xs text-muted-foreground">
                Agent replies to conversations are framed with this design — one template at a
                time. Replies are letters, not cards: the headline, heading sizes and social
                links don't apply. Switched off, replies use the stock personal look.
              </p>
            </Group>
          )}
        </fieldset>

        {/* ── preview — dominant, on a muted well; iframe width = device.
            EmailPreview is the shared frame (broadcast compose uses it too). ── */}
        <EmailPreview
          html={html}
          refreshing={refreshing}
          failed={previewFailed}
          className="min-w-0 flex-1 bg-muted/50"
        />
      </div>
    </div>
  );
}

// ── rail control primitives ──────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-small text-muted-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** Swatch (native color picker) + hex text field. The text field is the source
 *  of truth — it accepts the full #rgb…#rrggbbaa grammar the server does; only
 *  valid hex commits, and blur snaps the text back to the committed value. */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (v: string) => {
    setText(v);
    if (HEX_RE.test(v.trim())) onChange(v.trim().toLowerCase());
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-small text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <input
          type="color"
          value={toPickerHex(value)}
          onChange={(e) => commit(e.target.value)}
          aria-label={`${label} — pick a color`}
          className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-moz-color-swatch]:rounded-sm [&::-moz-color-swatch]:border-0"
        />
        <Input
          value={text}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setText(value)}
          spellCheck={false}
          aria-label={`${label} — hex value`}
          className="h-8 w-24 px-2 font-mono text-xs"
        />
      </span>
    </div>
  );
}

/** Compact bounded stepper. Typing is free-form locally; only a parseable
 *  number commits (clamped), and blur snaps the text to the committed value. */
function NumberRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(n)) {
      onChange(Math.min(max, Math.max(min, Math.round(n))));
    }
  };
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-small text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setText(String(value))}
        aria-label={label}
        className="h-8 w-20 px-2 text-xs tabular-nums"
      />
    </div>
  );
}

/** Label + URL rows with add/remove — capped at the server's limit of six. */
function SocialLinksEditor({
  links,
  onChange,
}: {
  links: SocialLink[];
  onChange: (l: SocialLink[]) => void;
}) {
  const setAt = (i: number, patch: Partial<SocialLink>) =>
    onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-1.5">
      {links.map((l, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={l.label}
            onChange={(e) => setAt(i, { label: e.target.value })}
            placeholder="Label"
            aria-label={`Social link ${i + 1} label`}
            className="h-8 w-24 shrink-0 px-2 text-xs"
          />
          <Input
            value={l.url}
            onChange={(e) => setAt(i, { url: e.target.value })}
            placeholder="https://…"
            spellCheck={false}
            aria-label={`Social link ${i + 1} URL`}
            className="h-8 min-w-0 flex-1 px-2 text-xs"
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(links.filter((_, j) => j !== i))}
            aria-label={`Remove social link ${i + 1}`}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      {links.length < 6 ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onChange([...links, { label: "", url: "" }])}
        >
          <Plus className="size-3.5" /> Add link
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">A footer holds at most six links.</p>
      )}
    </div>
  );
}
