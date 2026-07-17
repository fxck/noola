import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toaster";
import {
  sendBroadcast,
  cancelBroadcast,
  isBroadcastsUnavailable,
  type Broadcast,
} from "@/lib/broadcasts";
import { BroadcastDetail, sendTimeWords } from "@/routes/broadcasts";

// A real, URL-addressable broadcast page: /broadcasts/$broadcastId. Deep-linkable,
// shareable, and back-button-friendly — the routed replacement for the old
// master-detail pane. BroadcastDetail fetches fresh by id and streams live
// delivery tallies; Send/Schedule/Start route through the styled ConfirmDialog,
// and so does Stop (permanent). Canceling a schedule is reversible — it goes
// straight through, no dialog.
const routeApi = getRouteApi("/broadcasts/$broadcastId");

// What POST /send will do to this broadcast — drives the dialog copy, the
// confirm verb, and the success toast.
function sendOutcome(b: Broadcast): "sending" | "scheduled" | "active" {
  if (b.mode === "continuous") return "active";
  if (b.status === "draft" && b.send_at) return "scheduled";
  return "sending"; // plain draft, or a scheduled one being fired early
}

export function BroadcastDetailPage() {
  const { broadcastId } = routeApi.useParams();
  const navigate = useNavigate();

  const [confirming, setConfirming] = useState<Broadcast | null>(null); // send / schedule / start
  const [stopping, setStopping] = useState<Broadcast | null>(null); // active → permanent stop
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0); // bump to refetch the detail after an action

  const backToList = () => void navigate({ to: "/broadcasts" });
  const refresh = () => setReloadKey((k) => k + 1);

  async function doSend() {
    if (!confirming) return;
    setBusy(true);
    try {
      // The server reports which path the send took — trust it over our guess.
      const { status } = await sendBroadcast(confirming.id);
      if (status === "scheduled") {
        toast.success(
          confirming.send_at
            ? `Scheduled for ${sendTimeWords(confirming.send_at)}.`
            : "Scheduled.",
        );
      } else if (status === "active") {
        toast.success("Continuous broadcast started.");
      } else {
        toast.success("Sending — delivery counts will update live.");
      }
      refresh(); // detail refetches, sees the new status, adjusts its polling
    } catch (e) {
      toast.error(
        isBroadcastsUnavailable(e)
          ? "Sending isn't available on this server yet."
          : "Couldn't start sending. Please try again.",
      );
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  // The header's Cancel schedule / Stop actions. Disarming a schedule is
  // reversible (back to draft), so it fires immediately; stopping a continuous
  // broadcast is permanent, so it confirms first.
  function handleCancel(b: Broadcast) {
    if (b.status === "active") {
      setStopping(b);
      return;
    }
    void (async () => {
      try {
        await cancelBroadcast(b.id);
        toast.success("Schedule canceled — back to draft.");
        refresh();
      } catch {
        toast.error("Couldn't cancel the schedule. It may have already fired — refresh to see.");
      }
    })();
  }

  async function doStop() {
    if (!stopping) return;
    setBusy(true);
    try {
      await cancelBroadcast(stopping.id);
      toast.success("Broadcast stopped.");
      refresh();
    } catch {
      toast.error("Couldn't stop the broadcast. It may have already ended — refresh to see.");
    } finally {
      setBusy(false);
      setStopping(null);
    }
  }

  const outcome = confirming ? sendOutcome(confirming) : null;
  const n = confirming?.recipient_count ?? 0;
  const contacts = `${n.toLocaleString()} ${n === 1 ? "contact" : "contacts"}`;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        <BroadcastDetail
          key={`${broadcastId}:${reloadKey}`}
          broadcastId={broadcastId}
          onBack={backToList}
          onSend={(b) => setConfirming(b)}
          onCancel={handleCancel}
          // Draft re-edit: the composer lives on the list surface — hand it the
          // draft id via ?edit and it opens seeded from the draft.
          onEdit={(b) => void navigate({ to: "/broadcasts", search: { edit: b.id } })}
        />
      </div>

      {/* send / schedule / start — one dialog whose copy tracks the outcome */}
      <ConfirmDialog
        open={!!confirming}
        title={
          outcome === "scheduled"
            ? "Schedule this broadcast?"
            : outcome === "active"
              ? "Start this broadcast?"
              : "Send this broadcast?"
        }
        message={
          confirming
            ? outcome === "scheduled"
              ? `It will be delivered to ${contacts} ${confirming.send_at ? `at ${sendTimeWords(confirming.send_at)}` : "at the scheduled time"}. You can cancel the schedule any time before it fires.`
              : outcome === "active"
                ? `It sends once to each person the first time they match the audience, starting with the ${contacts} who match now.${confirming.stop_at ? ` It stops at ${sendTimeWords(confirming.stop_at)}.` : ""}`
                : `It will be delivered to ${contacts}${confirming.status === "scheduled" ? " now, instead of waiting for the schedule" : ""}. This can't be undone.`
            : undefined
        }
        confirmLabel={outcome === "scheduled" ? "Schedule" : outcome === "active" ? "Start" : "Send"}
        busy={busy}
        onConfirm={() => void doSend()}
        onCancel={() => setConfirming(null)}
      />

      {/* stop — permanent, so it earns the destructive confirm */}
      <ConfirmDialog
        open={!!stopping}
        title="Stop this broadcast?"
        message="Stopping is permanent — a stopped broadcast can't be resumed. People who already received it keep their copy."
        confirmLabel="Stop"
        destructive
        busy={busy}
        onConfirm={() => void doStop()}
        onCancel={() => setStopping(null)}
      />
    </>
  );
}
