import { useState } from "react";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

  const canSend = !!subject.trim() && !!body.trim() && !!contactEmail;

  async function submit() {
    if (!canSend || busy) return;
    setBusy(true);
    try {
      const res = await messageContact(contactId, {
        subject: subject.trim(),
        body: body.trim(),
        clientMessageId: crypto.randomUUID(),
      });
      toast.success(res.delivered ? "Message sent — conversation opened." : "Conversation opened — delivery is pending.");
      setSubject("");
      setBody("");
      onSent(res.ticketId);
    } catch (e) {
      const status = (e as { status?: number }).status;
      toast.error(
        status === 422
          ? "This contact has no email address to reach them on."
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
          ? `Emails ${contactEmail} and opens a conversation you can follow in the inbox.`
          : "This contact has no email address on file, so there's no way to reach them yet."
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
          <Label htmlFor="msg-body">Message</Label>
          <Textarea
            id="msg-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            placeholder={`Hi ${firstName},`}
            maxLength={10000}
            disabled={busy}
          />
        </div>
      </div>
    </FormDialog>
  );
}
