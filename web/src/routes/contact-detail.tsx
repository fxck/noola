import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import { useNerdMode } from "@/lib/nerd-mode";
import { deleteContact, eraseContact, type Contact } from "@/lib/contacts";
import { ContactDetail } from "@/components/contacts/contact-detail";
import { ContactForm } from "@/components/contacts/contact-form";

// A real, URL-addressable contact page: /contacts/$contactId. Deep-linkable,
// shareable, and back-button-friendly — the routed replacement for the old
// state-only slide-over. View ⇄ inline edit; delete confirms then returns to the list.
const routeApi = getRouteApi("/contacts/$contactId");

export function ContactDetailPage() {
  const { contactId } = routeApi.useParams();
  const navigate = useNavigate();
  const { nerd } = useNerdMode();

  const [editing, setEditing] = useState<Contact | null>(null);
  const [detailKey, setDetailKey] = useState(0); // bump to refetch the detail after a save
  const [confirming, setConfirming] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);
  // GDPR erasure (0092): a distinct, admin-only destructive path (contact + all conversations).
  const [erasing, setErasing] = useState<Contact | null>(null);
  const [erasingBusy, setErasingBusy] = useState(false);

  const backToList = () => void navigate({ to: "/contacts" });

  async function doDelete() {
    if (!confirming) return;
    setDeleting(true);
    try {
      await deleteContact(confirming.id);
      toast.success("Contact deleted.");
      void navigate({ to: "/contacts" });
    } catch {
      toast.error("Couldn't delete that contact. Please try again.");
      setDeleting(false);
      setConfirming(null);
    }
  }

  async function doErase() {
    if (!erasing) return;
    setErasingBusy(true);
    try {
      await eraseContact(erasing.id);
      toast.success("Contact and all their conversations were erased.");
      void navigate({ to: "/contacts" });
    } catch (e) {
      toast.error((e as { status?: number }).status === 403 ? "Only admins can erase a contact." : "Couldn't erase that contact.");
      setErasingBusy(false);
      setErasing(null);
    }
  }

  return (
    <>
      {editing ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ContactForm
            mode="edit"
            initial={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              setDetailKey((k) => k + 1);
              toast.success("Contact saved.");
            }}
            onError={(msg) => toast.error(msg)}
          />
        </div>
      ) : (
        <ContactDetail
          key={`${contactId}:${detailKey}`}
          contactId={contactId}
          initial={null}
          nerd={nerd}
          onBack={backToList}
          onEdit={(c) => setEditing(c)}
          onDelete={(c) => setConfirming(c)}
          onErase={(c) => setErasing(c)}
        />
      )}

      <ConfirmDialog
        open={!!confirming}
        title="Delete contact?"
        message={
          confirming
            ? `${confirming.name || confirming.email || "This contact"} will be permanently removed. This can't be undone.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmDialog
        open={!!erasing}
        title="Erase everything for this contact?"
        message={
          erasing
            ? `${erasing.name || erasing.email || "This contact"}, all their conversations, messages and attachments will be permanently deleted for GDPR erasure. This can't be undone.`
            : undefined
        }
        confirmLabel="Erase everything"
        destructive
        busy={erasingBusy}
        onConfirm={() => void doErase()}
        onCancel={() => setErasing(null)}
      />
    </>
  );
}
