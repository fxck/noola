import { useEffect, useState } from "react";
import type { Ticket } from "@/lib/tickets";
import { markTicketSpam } from "@/lib/tickets";
import { FormDialog } from "@/components/ui/form-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

/** The sender identity to show in the dialog — an email address for email-origin tickets, else the
 *  channel handle we hold. `external_channel_id` carries the address for email; null when we can't
 *  name it (the block still works — the server derives the sender from the ticket). */
function senderAddress(ticket: Ticket): string | null {
  const id = ticket.external_channel_id?.trim();
  if (id && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return id;
  return null;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) : null;
}

/**
 * The "Mark as spam" confirm dialog: hides the ticket, optionally blocks the sender (by exact
 * address or their whole domain) and drops the auto-created lead — all reversible from the Spam view.
 * On a widget ticket the block is a ban of the visitor's user from the chat.
 */
export function SpamDialog({
  ticket,
  open,
  onClose,
  onSpammed,
}: {
  ticket: Ticket;
  open: boolean;
  onClose: () => void;
  onSpammed: () => void;
}) {
  const isWidget = ticket.channel_type === "widget";
  const [block, setBlock] = useState(!isWidget);
  const [blockScope, setBlockScope] = useState<"address" | "domain">("address");
  // The dialog stays mounted across tickets, so each open starts from the defaults for this channel.
  useEffect(() => {
    if (!open) return;
    setBlock(!isWidget);
    setBlockScope("address");
  }, [open, isWidget]);
  const [dropLead, setDropLead] = useState(true);
  const [busy, setBusy] = useState(false);

  const address = senderAddress(ticket);
  const domain = address ? domainOf(address) : null;

  async function onConfirm() {
    setBusy(true);
    try {
      const r = await markTicketSpam(ticket.id, isWidget ? { block, dropLead } : { block, blockScope, dropLead });
      if (block && !r.blocked)
        toast.info(
          isWidget
            ? "Marked as spam. This visitor has no account or e-mail to ban."
            : "Marked as spam. There is no sender address to block.",
        );
      else toast.success("Marked as spam");
      if (r.blocked && !block)
        toast.info(
          isWidget
            ? "This user was banned from the chat automatically after repeated spam."
            : `${r.blocked} was blocked automatically after repeated spam.`,
        );
      onSpammed();
      onClose();
    } catch {
      toast.error("Couldn't mark this as spam.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title="Mark as spam"
      description={
        isWidget
          ? "Hides this conversation and removes the lead it created. Everything here is reversible from the Spam view."
          : "Hides this conversation, blocks the sender, and removes the lead it created. Everything here is reversible from the Spam view."
      }
      onClose={onClose}
      onSubmit={() => void onConfirm()}
      submitLabel="Mark as spam"
      busy={busy}
    >
      <div className="space-y-4">
        {address && (
          <p className="text-xs text-muted-foreground">
            Sender: <span className="font-mono text-foreground">{address}</span>
          </p>
        )}

        {isWidget ? (
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox checked={block} onCheckedChange={setBlock} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Ban this user from the chat</span>
              <span className="block text-xs text-muted-foreground">
                They can no longer send chat messages. Their account itself is not banned.
              </span>
            </span>
          </label>
        ) : (
          /* Block the sender + scope */
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox checked={block} onCheckedChange={setBlock} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">Block this sender</span>
                <span className="block text-xs text-muted-foreground">
                  Future messages from them are dropped before a ticket is ever created.
                </span>
              </span>
            </label>

            {block && (
              <div className="ml-6 grid gap-1.5 sm:grid-cols-2">
                {(["address", "domain"] as const).map((s) => {
                  const label = s === "address" ? "This address" : "The whole domain";
                  const value = s === "address" ? address : domain;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setBlockScope(s)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors",
                        blockScope === s ? "border-primary bg-primary/5" : "text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <span className="block text-xs font-medium text-foreground">{label}</span>
                      <span className="block truncate font-mono text-micro text-muted-foreground" title={value ?? undefined}>
                        {value ?? "—"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Drop the auto-created lead */}
        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox checked={dropLead} onCheckedChange={setDropLead} className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              Also remove the lead from Customers
            </span>
            <span className="block text-xs text-muted-foreground">
              Deletes the contact this conversation auto-created. Restoring the ticket brings it back.
            </span>
          </span>
        </label>
      </div>
    </FormDialog>
  );
}
