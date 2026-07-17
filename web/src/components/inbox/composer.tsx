import { useEffect, useRef, useState } from "react";
import {
  SendHorizonal,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  BookOpen,
  FileText,
  MessagesSquare,
  Pencil,
  X,
  StickyNote,
  MessageSquareText,
  Paperclip,
  ChevronDown,
  Check,
  Mail,
  MessageCircle,
  Hash,
  Phone,
  Send,
} from "lucide-react";
import {
  type Ticket,
  type AgentUser,
  type Citation,
  type Suggestion,
  type Attachment,
  type ReplyChannels,
  sendReply,
  suggestReply,
  uploadAttachment,
  formatBytes,
} from "@/lib/tickets";
import { type QueueItem, sendQueued, dismissQueued } from "@/lib/autoreply";
import { useQueue } from "@/lib/queue-context";
import { addNote } from "@/lib/notes";
import { type Macro, fetchMacros } from "@/lib/macros";
import { NoteComposer } from "@/components/inbox/note-composer";
import { ChatComposer, type ChatComposerHandle } from "@/components/inbox/chat-composer";
import { DraftReceipt, ReasonChip } from "@/components/queue/draft-receipt";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtime } from "@/lib/realtime-context";
import { useNerdMode } from "@/lib/nerd-mode";
import { NerdStats, ScoreBar, CopyId, fmtMs, fmtScore, fmtTokens, type StatRow } from "@/components/live/nerd-stats";
import { cn } from "@/lib/utils";

// Channel display metadata for the reply channel picker — a label + icon per known channel, so an
// agent can send the reply on any channel the contact is reachable on. Unknown channels fall back
// to a capitalized name + a generic bubble icon.
const CHANNEL_META: Record<string, { label: string; icon: typeof Mail }> = {
  email: { label: "Email", icon: Mail },
  widget: { label: "Chat", icon: MessageCircle },
  discord: { label: "Discord", icon: Hash },
  slack: { label: "Slack", icon: Hash },
  telegram: { label: "Telegram", icon: Send },
  whatsapp: { label: "WhatsApp", icon: Phone },
  synthetic: { label: "Synthetic", icon: MessageSquareText },
};
function channelMeta(type: string): { label: string; icon: typeof Mail } {
  return CHANNEL_META[type] ?? { label: type.charAt(0).toUpperCase() + type.slice(1), icon: MessageSquareText };
}

// The reply composer footer: reply vs internal-note modes, the "Draft with AI" copilot (with
// citation chips), macros, the approval-queue draft actions (send/edit/dismiss a pending
// suggested reply), typing-presence broadcast, and ⌘↵-to-send. Self-contained; talks to the
// parent only through onSent / onMutated / onNoteAdded. Reply mode runs a rich Lexical
// editor (ChatComposer) that mirrors its markdown into `body`, so everything downstream
// (send, macros, AI drafts, queue edits) still speaks plain markdown strings.
export function Composer({
  ticket,
  users,
  isDiscord,
  replyChannels,
  defaultCc,
  pending,
  onSent,
  onMutated,
  onNoteAdded,
}: {
  ticket: Ticket;
  users: AgentUser[];
  isDiscord: boolean;
  replyChannels: ReplyChannels | null;
  /** The other recipients on the customer's latest email — the reply-all default (email only). */
  defaultCc?: string[];
  pending: QueueItem | null;
  onSent: () => void;
  onMutated: () => void;
  onNoteAdded: () => void;
}) {
  const { setPresence } = useRealtime();
  const { nerd } = useNerdMode();
  const { removeItem, refetch: refetchQueue } = useQueue();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  // Reply vs internal note. In "note" mode, Send saves an agent-only note (no dispatch).
  const [mode, setMode] = useState<"reply" | "note">("reply");
  // Note mode runs a Lexical editor; it reports plain text (mirrored into `body` for the
  // shared Send button) + the mention chips' member ids. `noteReset` clears it after send.
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [noteReset, setNoteReset] = useState(0);
  // Reply mode's mirror of the same pattern: bumping `replyReset` clears the rich editor
  // (after send, or when a queue-draft edit is cancelled).
  const [replyReset, setReplyReset] = useState(0);
  // Email reply-all (0092): the Cc recipients. Seeded from the customer's last email's other
  // recipients (defaultCc), editable, and only sent when the reply goes out on email.
  const [cc, setCc] = useState<string[]>([]);
  const [ccOpen, setCcOpen] = useState(false);
  const [ccInput, setCcInput] = useState("");
  // Macros: fetched lazily the first time the picker opens (avoids a call per ticket).
  const [macros, setMacros] = useState<Macro[] | null>(null);
  const [macrosOpen, setMacrosOpen] = useState(false);
  // Reply channel: which channel the reply is sent on. null = the ticket's default (current) channel;
  // set when the agent picks another channel the contact is reachable on. Reset per ticket.
  const [channel, setChannel] = useState<string | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [citations, setCitations] = useState<Citation[] | null>(null);
  const [copilotNote, setCopilotNote] = useState<string | null>(null);
  const [sug, setSug] = useState<Suggestion | null>(null);
  // Approval-queue draft acting: which pending id (if any) we're editing, and a busy flag.
  const [queueBusy, setQueueBusy] = useState(false);
  const [editingPending, setEditingPending] = useState<string | null>(null);
  // Reply attachments: uploaded eagerly on pick/paste (pending rows), claimed onto the message on send.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Local image previews for pending attachments, keyed by attachment id — object URLs from
  // the picked File (the server copy is auth-gated), revoked on remove/clear/unmount.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  // Imperative handle into the reply editor — programmatic content (macros, AI
  // drafts, queue-draft edits) goes through it; typed content flows back via onChange.
  const replyRef = useRef<ChatComposerHandle>(null);

  // Typing presence: broadcast that we're composing on this ticket while there's
  // unsent text, clearing after a short idle, on blur, on send, and on unmount.
  const typingOn = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function markTyping(on: boolean) {
    if (typingOn.current === on) return;
    typingOn.current = on;
    setPresence({ typing: on ? ticket.id : null });
  }
  function pingTyping(text: string) {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (!text.trim()) {
      markTyping(false);
      return;
    }
    markTyping(true);
    typingTimer.current = setTimeout(() => markTyping(false), 3000);
  }
  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      markTyping(false);
      for (const u of Object.values(previewsRef.current)) URL.revokeObjectURL(u);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Revoke every pending preview object URL and drop the map. */
  function clearPreviews() {
    setPreviews((prev) => {
      for (const u of Object.values(prev)) URL.revokeObjectURL(u);
      return {};
    });
  }

  // fresh ticket → fresh draft
  useEffect(() => {
    setBody("");
    setNote(null);
    setMode("reply");
    setMentionIds([]);
    setNoteReset((n) => n + 1);
    setMacrosOpen(false);
    setCitations(null);
    setCopilotNote(null);
    setSug(null);
    setEditingPending(null);
    setAttachments([]);
    setChannel(null);
    setChannelOpen(false);
    setCc(defaultCc ?? []);
    setCcOpen(false);
    setCcInput("");
    clearPreviews();
    if (typingTimer.current) clearTimeout(typingTimer.current);
    markTyping(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  // defaultCc arrives async (the thread read resolves after the ticket switches) — seed the Cc
  // set from it once it lands, and auto-open the Cc row when there are reply-all recipients.
  useEffect(() => {
    setCc(defaultCc ?? []);
    if (defaultCc && defaultCc.length > 0) setCcOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, (defaultCc ?? []).join(",")]);

  // The reply's effective channel + the picker's options. `activeChannel` defaults to the ticket's
  // current channel until the agent picks another; the picker only appears when the contact is
  // reachable on more than one channel.
  const channelOptions = replyChannels?.channels ?? [];
  const activeChannel = channel ?? replyChannels?.current ?? ticket.channel_type;
  const showChannelPicker = channelOptions.length > 1;
  const ActiveChannelIcon = channelMeta(activeChannel).icon;

  // Upload picked/pasted files as pending attachments. Each resolves to a claimable attachment id.
  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setNote(null);
    for (const file of files) {
      setUploading((n) => n + 1);
      try {
        const a = await uploadAttachment(ticket.id, file);
        setAttachments((prev) => [...prev, a]);
        if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
          const url = URL.createObjectURL(file);
          setPreviews((prev) => ({ ...prev, [a.id]: url }));
        }
      } catch {
        setNote({ kind: "warn", text: `Couldn't attach ${file.name}.` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setPreviews((prev) => {
      const url = prev[id];
      if (!url) return prev;
      URL.revokeObjectURL(url);
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // Insert a macro body into the composer: fill an empty draft, else append below.
  // (The handle focuses + lands the caret at the end; its onChange echo keeps
  // `body` and typing presence in step — no manual setBody/pingTyping here.)
  function insertMacro(m: Macro) {
    if (body.trim()) replyRef.current?.insertMarkdown(m.body);
    else replyRef.current?.setMarkdown(m.body);
    setMacrosOpen(false);
  }

  function toggleMacros() {
    const next = !macrosOpen;
    setMacrosOpen(next);
    if (next && macros === null) {
      fetchMacros().then(setMacros).catch(() => setMacros([]));
    }
  }

  // ── Approval-queue draft: act on the pending "Suggested reply" for this ticket ──
  async function sendPending(item: QueueItem, edited?: string) {
    if (queueBusy) return;
    setQueueBusy(true);
    setNote(null);
    removeItem(item.id); // optimistic — the card disappears immediately
    try {
      await sendQueued(item.id, edited);
      if (editingPending === item.id) {
        setEditingPending(null);
        setBody("");
        setReplyReset((n) => n + 1);
      }
      if (typingTimer.current) clearTimeout(typingTimer.current);
      markTyping(false);
      onSent();
      onMutated();
    } catch {
      setNote({ kind: "warn", text: "Couldn't send the suggested reply — please try again." });
      refetchQueue(); // restore the card
    } finally {
      setQueueBusy(false);
    }
  }

  async function dismissPending(item: QueueItem) {
    if (queueBusy) return;
    setQueueBusy(true);
    removeItem(item.id); // optimistic
    if (editingPending === item.id) {
      setEditingPending(null);
      setBody("");
      setReplyReset((n) => n + 1);
    }
    try {
      await dismissQueued(item.id);
    } catch {
      refetchQueue();
    } finally {
      setQueueBusy(false);
    }
  }

  function editPending(item: QueueItem) {
    setMode("reply");
    setEditingPending(item.id);
    // Load one frame later — we may be flipping from note mode, where the reply
    // editor isn't mounted until React commits the mode switch. The editor's
    // onChange echo then sets `body` + typing presence.
    requestAnimationFrame(() => replyRef.current?.setMarkdown(item.draft_body));
  }

  function cancelEditPending() {
    setEditingPending(null);
    setBody("");
    setReplyReset((n) => n + 1);
    markTyping(false);
  }

  // Copilot: ask the server for a retrieval-grounded draft, drop it into the
  // composer, and show which sources it drew on. The agent edits before sending.
  async function draftWithAI() {
    if (suggesting) return;
    setSuggesting(true);
    setNote(null);
    setCopilotNote(null);
    try {
      const s = await suggestReply(ticket.id);
      replyRef.current?.setMarkdown(s.draft);
      setCitations(s.citations);
      setSug(s);
      setCopilotNote(
        s.citations.length > 0
          ? `Drafted from ${s.citations.length} ${s.citations.length === 1 ? "source" : "sources"} · review before sending`
          : "No matching sources yet — drafted a safe reply. Review before sending.",
      );
    } catch {
      setCopilotNote("Couldn't draft a reply — please try again.");
    } finally {
      setSuggesting(false);
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || sending || queueBusy) return;
    // Internal note mode: save an agent-only note (never dispatched to a channel).
    if (mode === "note") {
      setSending(true);
      setNote(null);
      try {
        await addNote(ticket.id, text, mentionIds);
        setBody("");
        setMentionIds([]);
        setNoteReset((n) => n + 1);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        markTyping(false);
        onNoteAdded();
      } catch {
        setNote({ kind: "warn", text: "Couldn't save the note — please try again." });
      } finally {
        setSending(false);
      }
      return;
    }
    // If we're editing a pending queue draft, deliver it through the queue so the
    // approval item resolves (rather than posting a duplicate reply).
    if (editingPending && pending && pending.id === editingPending) {
      await sendPending(pending, text);
      return;
    }
    setSending(true);
    setNote(null);
    try {
      const emailCc = activeChannel === "email" ? cc : undefined;
      const { delivered } = await sendReply(ticket.id, text, attachments.map((a) => a.id), activeChannel, emailCc);
      setBody("");
      setReplyReset((n) => n + 1);
      setAttachments([]);
      clearPreviews();
      setCitations(null);
      setCopilotNote(null);
      setSug(null);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      markTyping(false);
      onSent();
      onMutated();
      if (isDiscord) {
        setNote(
          delivered
            ? { kind: "ok", text: "Sent — delivered to Discord." }
            : { kind: "warn", text: "Saved, but Discord delivery failed." },
        );
      }
      replyRef.current?.focus();
    } catch {
      setNote({ kind: "warn", text: "Couldn't send — please try again." });
    } finally {
      setSending(false);
    }
  }

  return (
    // STRUCTURE.md §7 — the composer is a single floating surface pinned at the
    // thread bottom: no full-width border-t band, tools quiet, one Send.
    <footer className="shrink-0 px-3 pb-3 pt-1 sm:px-4">
      <div className="@container mx-auto flex max-w-3xl flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-sm">
        {/* Approval queue: a draft is waiting on this ticket — act without leaving. */}
        {pending &&
          (editingPending === pending.id ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-primary">
                <Sparkles className="size-3.5" /> Editing the suggested reply — press Send to deliver.
              </span>
              <Button variant="ghost" size="sm" onClick={cancelEditPending} disabled={queueBusy}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Sparkles className="size-3.5" /> Suggested reply
                </span>
                <ReasonChip reason={pending.reason} />
              </div>
              <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                {pending.draft_body}
              </p>
              <DraftReceipt meta={pending.meta} className="mt-2" />
              <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void dismissPending(pending)}
                  disabled={queueBusy}
                >
                  <X /> Dismiss
                </Button>
                <Button variant="outline" size="sm" onClick={() => editPending(pending)} disabled={queueBusy}>
                  <Pencil /> Edit
                </Button>
                <Button size="sm" onClick={() => void sendPending(pending)} disabled={queueBusy}>
                  {queueBusy ? <Spinner className="size-4 text-background" /> : <SendHorizonal />}
                  Send
                </Button>
              </div>
            </div>
          ))}

        {/* Reply vs internal note — a small quiet segmented control */}
        <div className="inline-flex w-fit items-center rounded-lg bg-muted/60 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
              mode === "reply" ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <SendHorizonal className="size-3.5" /> Reply
          </button>
          <button
            type="button"
            data-testid="composer-note-toggle"
            onClick={() => setMode("note")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors",
              mode === "note" ? "bg-background font-medium text-warning shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <StickyNote className="size-3.5" /> Internal note
          </button>
        </div>

        {/* Pending attachments — uploaded, waiting to ride the next reply. Images show as
            real thumbnails (local object URL — the server copy is auth-gated); other files
            keep the compact chip. Above the input so the draft reads top-to-bottom. Shown in
            BOTH modes: they persist across the Reply/Note toggle anyway, and hiding the row
            in note mode made the composer jump heights when switching. */}
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
            {attachments.map((a) =>
              previews[a.id] ? (
                <span key={a.id} className="group relative">
                  <img
                    src={previews[a.id]}
                    alt={a.filename}
                    title={`${a.filename} · ${formatBytes(a.size_bytes)}`}
                    className="size-14 rounded-lg border border-border/60 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename}`}
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ) : (
                <span
                  key={a.id}
                  className="inline-flex max-w-[15rem] items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-xs"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{a.filename}</span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(a.size_bytes)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.filename}`}
                    className="shrink-0 text-muted-foreground/60 hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ),
            )}
            {uploading > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-xs text-muted-foreground">
                <Spinner className="size-3.5" /> Uploading…
              </span>
            )}
          </div>
        )}

        {/* Cc recipients (email reply-all, 0092): chips + a type-to-add field. Only meaningful on
            the email channel; a chip is committed on Enter/comma/blur if it's a valid address. */}
        {mode === "reply" && activeChannel === "email" && ccOpen && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1.5">
            <span className="shrink-0 text-micro font-medium uppercase tracking-wide text-muted-foreground">Cc</span>
            {cc.map((addr) => (
              <span key={addr} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs">
                <span className="truncate">{addr}</span>
                <button
                  type="button"
                  aria-label={`Remove ${addr}`}
                  className="text-muted-foreground/60 hover:text-destructive"
                  onClick={() => setCc((xs) => xs.filter((x) => x !== addr))}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              value={ccInput}
              onChange={(e) => setCcInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  const addr = ccInput.trim().toLowerCase().replace(/,$/, "");
                  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) && !cc.includes(addr)) {
                    setCc((xs) => [...xs, addr]);
                    setCcInput("");
                  }
                } else if (e.key === "Backspace" && !ccInput && cc.length) {
                  setCc((xs) => xs.slice(0, -1));
                }
              }}
              onBlur={() => {
                const addr = ccInput.trim().toLowerCase();
                if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) && !cc.includes(addr)) {
                  setCc((xs) => [...xs, addr]);
                  setCcInput("");
                }
              }}
              placeholder={cc.length ? "" : "add email…"}
              className="min-w-[8rem] flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        )}

        {mode === "note" ? (
          <NoteComposer
            members={users}
            resetKey={`${ticket.id}:${noteReset}`}
            placeholder="Add an internal note — only your team sees this. @ to loop someone in…"
            onChange={({ text, mentionIds: ids }) => {
              setBody(text);
              setMentionIds(ids);
              pingTyping(text);
            }}
            onSubmit={() => void send()}
          />
        ) : (
          // Rich reply editor at the plain textarea's exact rest footprint (3.75rem —
          // ChatComposer documents the parity math). Its markdown mirrors into `body`
          // on every change; paste-with-files routes to the attachment uploader.
          <ChatComposer
            ref={replyRef}
            resetKey={`${ticket.id}:${replyReset}`}
            placeholder={isDiscord ? "Reply — this posts back to Discord…" : "Write a reply…"}
            disabled={sending}
            onChange={(md) => {
              setBody(md);
              pingTyping(md);
            }}
            onSubmit={() => void send()}
            onFiles={(files) => void addFiles(files)}
            onBlur={() => markTyping(false)}
          />
        )}

        {/* Copilot: what the draft drew on. Chips cite the KB articles and
            documents the retrieval used, so the agent can trust or trace it. */}
        {citations && citations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Sources</span>
            {citations.map((c) => (
              <span
                key={`${c.kind}-${c.id}`}
                title={c.snippet}
                className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs text-muted-foreground"
              >
                {c.kind === "kb" ? (
                  <BookOpen className="size-3 shrink-0" />
                ) : c.kind === "thread" ? (
                  <MessagesSquare className="size-3 shrink-0" />
                ) : (
                  <FileText className="size-3 shrink-0" />
                )}
                <span className="truncate">{c.title}</span>
              </span>
            ))}
          </div>
        )}
        {copilotNote && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" />
            {copilotNote}
          </p>
        )}

        {/* nerd: the retrieval + model instrumentation behind the draft */}
        {nerd && sug && <SuggestionStats sug={sug} onDismiss={() => setSug(null)} />}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* Reply channel: send on any channel the contact is reachable on (default = the
                ticket's current channel). Only shown when there's more than one to choose from. */}
            {mode === "reply" && showChannelPicker && (
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setChannelOpen((v) => !v)}
                  disabled={sending}
                  title="Choose the channel this reply is sent on"
                  aria-label={`Reply channel: ${channelMeta(activeChannel).label}`}
                  className="gap-1.5"
                >
                  <ActiveChannelIcon className="size-3.5 text-muted-foreground" />
                  {channelMeta(activeChannel).label}
                  <ChevronDown className="size-3 text-muted-foreground" />
                </Button>
                {channelOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setChannelOpen(false)} aria-hidden />
                    <div className="absolute bottom-full left-0 z-20 mb-1 w-52 overflow-hidden rounded-lg border bg-card p-1 shadow-md">
                      <p className="px-2 pb-1 pt-1.5 text-micro font-medium uppercase tracking-wide text-muted-foreground">
                        Send reply on
                      </p>
                      {channelOptions.map((c) => {
                        const m = channelMeta(c);
                        const Icon = m.icon;
                        const active = c === activeChannel;
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => { setChannel(c); setChannelOpen(false); }}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                          >
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex-1 truncate">{m.label}</span>
                            {c === replyChannels?.current && (
                              <span className="shrink-0 text-micro text-muted-foreground">default</span>
                            )}
                            {active && <Check className="size-3.5 shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {mode === "reply" && activeChannel === "email" && !ccOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCcOpen(true)}
                title="Add Cc recipients (reply-all)"
                className="text-muted-foreground hover:text-foreground"
              >
                Cc{cc.length > 0 ? ` (${cc.length})` : ""}
              </Button>
            )}

            {mode === "reply" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void draftWithAI()}
                disabled={suggesting || sending}
                title="Draft a reply from your knowledge base and sources"
                className="text-muted-foreground hover:text-foreground"
              >
                {suggesting ? <Spinner className="size-4" /> : <Sparkles className="text-primary" />}
                {suggesting ? "Drafting…" : "Draft with AI"}
              </Button>
            )}

            {/* Attach a file to the reply */}
            {mode === "reply" && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void addFiles(Array.from(e.target.files ?? []));
                    e.target.value = ""; // allow re-picking the same file
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  onClick={() => fileRef.current?.click()}
                  disabled={sending}
                  title="Attach a file"
                  aria-label="Attach a file"
                >
                  <Paperclip />
                </Button>
              </>
            )}

            {/* Macros — insert a saved canned response into the reply composer */}
            {mode === "reply" && (
            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={toggleMacros}
                disabled={sending}
                title="Insert a saved reply"
                aria-label="Insert a saved reply"
              >
                <MessageSquareText />
              </Button>
              {macrosOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMacrosOpen(false)} aria-hidden />
                  <div className="absolute bottom-full left-0 z-20 mb-1 max-h-72 w-72 overflow-y-auto rounded-lg border bg-card p-1 shadow-md">
                    {macros === null ? (
                      <div className="flex items-center justify-center py-4">
                        <Spinner className="size-4" />
                      </div>
                    ) : macros.length === 0 ? (
                      <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No macros yet. Add them in Settings → Macros.
                      </p>
                    ) : (
                      macros.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => insertMacro(m)}
                          className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                        >
                          <span className="flex w-full items-center gap-1.5 text-sm font-medium">
                            <span className="truncate">{m.name}</span>
                            {m.shortcut && (
                              <code className="ml-auto shrink-0 rounded border bg-muted/50 px-1 font-mono text-micro text-muted-foreground">
                                {m.shortcut}
                              </code>
                            )}
                          </span>
                          <span className="line-clamp-2 text-xs text-muted-foreground">{m.body}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
            )}

            <span
              className={cn(
                "hidden min-w-0 items-center gap-1.5 truncate text-xs @[26rem]:flex",
                note?.kind === "warn" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {note?.kind === "warn" && <AlertTriangle className="size-3.5" />}
              {note?.kind === "ok" && <CheckCircle2 className="size-3.5 text-success" />}
              {note ? note.text : <span>⌘↵ to {mode === "note" ? "save" : "send"}</span>}
            </span>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => void send()} disabled={sending || queueBusy || uploading > 0 || !body.trim()}>
            {sending || queueBusy ? (
              <Spinner className="size-4 text-background" />
            ) : mode === "note" ? (
              <StickyNote />
            ) : (
              <SendHorizonal />
            )}
            {mode === "note" ? "Add note" : editingPending ? "Send edited" : "Send"}
          </Button>
        </div>
      </div>
    </footer>
  );
}

// Nerd panel: the retrieval + model instrumentation behind a copilot draft.
function SuggestionStats({ sug, onDismiss }: { sug: Suggestion; onDismiss: () => void }) {
  const r = sug.retrieval;
  const rows: StatRow[] = [];
  if (sug.model) rows.push({ label: "model", value: sug.model, title: sug.model });
  if (sug.confidence != null) rows.push({ label: "confidence", value: fmtScore(sug.confidence) });
  if (r) rows.push({ label: "top score", value: fmtScore(r.topScore) });
  if (r) {
    const denom = r.perCitation?.length || r.citedKinds?.length || undefined;
    rows.push({ label: "agreement", value: denom ? `${r.agreement}/${denom}` : `${r.agreement}` });
  }
  if (sug.tokensIn != null || sug.tokensOut != null) {
    rows.push({
      label: "tokens",
      value: `${fmtTokens(sug.tokensIn)} in · ${fmtTokens(sug.tokensOut)} out`,
    });
  }
  if (sug.latencyMs != null) rows.push({ label: "latency", value: fmtMs(sug.latencyMs) });

  return (
    <NerdStats title="copilot retrieval" rows={rows} onDismiss={onDismiss}>
      {r?.citedKinds && r.citedKinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          <span className="text-muted-foreground">kinds</span>
          {r.citedKinds.map((k) => (
            <span key={k} className="rounded border border-border px-1 py-px text-micro text-muted-foreground">
              {k}
            </span>
          ))}
        </div>
      )}
      {r?.perCitation && r.perCitation.length > 0 && (
        <div className="space-y-1 pt-1">
          {r.perCitation.map((c) => (
            <ScoreBar key={`${c.kind}-${c.id}`} label={c.kind} score={c.score} />
          ))}
        </div>
      )}
      {sug.traceId && (
        <div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground">
          <span>trace</span>
          <CopyId value={sug.traceId} className="text-muted-foreground" />
        </div>
      )}
    </NerdStats>
  );
}
