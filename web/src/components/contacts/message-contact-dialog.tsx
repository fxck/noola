import { useState } from "react";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/editor/rich-text-editor";
import { toast } from "@/components/ui/toaster";
import { messageContact } from "@/lib/contacts";

/**
 * Compose a NEW outbound conversation with one contact — Intercom's "New message". The agent writes a
 * subject + body; sending creates an inbox-visible ticket, delivers over the contact's reachable
 * channel (email today), and hands the new ticket id back so the caller can jump into the thread. The
 * contact's reply threads straight back into this conversation.
 */
export function MessageContactDialog({
  open,
  contactId,
  contactName,
  contactEmail,
  onClose,
  onSent,
}: {
  open: boolean;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  onClose: () => void;
  onSent: (ticketId: string) => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  // Reachability is resolved server-side (in-app if they're active in the widget, else email), so the
  // compose only needs content — a truly unreachable contact comes back as a 422 we surface below.
  const canSend = !!subject.trim() && !!body.trim();

  async function submit() {
    if (!canSend || busy) return;
    setBusy(true);
    try {
      const res = await messageContact(contactId, {
        subject: subject.trim(),
        body: body.trim(),
        clientMessageId: crypto.randomUUID(),
      });
      const where = res.channel === "widget" ? "in-app" : "by email";
      toast.success(
        res.delivered || res.channel === "widget"
          ? `Message sent ${where} — conversation opened.`
          : "Conversation opened — delivery is pending.",
      );
      setSubject("");
      setBody("");
      onSent(res.ticketId);
    } catch (e) {
      const status = (e as { status?: number }).status;
      toast.error(
        status === 422
          ? "There's no way to reach this contact yet — no email, and they haven't used the chat widget."
          : "Couldn't start that conversation. Please try again.",
      );
      setBusy(false);
    }
  }

  const firstName = contactName.split(" ")[0] || "there";

  return (
    <FormDialog
      open={open}
      title={`Message ${contactName}`}
      description={
        contactEmail
          ? `Delivered in-app if they're active in the chat widget, otherwise emailed to ${contactEmail}. Opens a conversation you can follow in the inbox.`
          : "Delivered in-app if they're active in the chat widget. Opens a conversation you can follow in the inbox."
      }
      onClose={() => {
        if (busy) return;
        setSubject("");
        setBody("");
        onClose();
      }}
      onSubmit={() => void submit()}
      submitLabel="Send"
      submitDisabled={!canSend}
      busy={busy}
      size="lg"
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="msg-subject">Subject</Label>
          <Input
            id="msg-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What's this about?"
            autoFocus
            maxLength={200}
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <Label>Message</Label>
          {/* The same Lexical composer the inbox reply box uses — markdown shortcuts, toolbar,
              links — serialized to markdown via onChange (rendered identically on delivery). */}
          <div className="overflow-hidden rounded-md border">
            <RichTextEditor
              initialMarkdown=""
              onChange={setBody}
              placeholder={`Hi ${firstName},`}
              ariaLabel="Message"
              minHeight={180}
            />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}
