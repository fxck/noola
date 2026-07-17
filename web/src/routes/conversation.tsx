import { useEffect, useRef, useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { ThreadPane } from "@/components/inbox/thread-pane";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtime } from "@/lib/realtime-context";
import { type Ticket, type AgentUser, fetchTicket, fetchUsers } from "@/lib/tickets";

const routeApi = getRouteApi("/tickets/$ticketId");

/**
 * Focused single-conversation view, opened from the Tickets table (URL-tracked by
 * id). It is the SAME ThreadPane the inbox uses — no second detail surface — just
 * rendered without the list column and with a Back button to the table. Every
 * ticket control lives in the pane's right rail.
 */
export function ConversationPage() {
  const { ticketId } = routeApi.useParams();
  const navigate = useNavigate();
  const { subscribe } = useRealtime();

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [users, setUsers] = useState<AgentUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [rtSignal, setRtSignal] = useState(0);

  function reload() {
    fetchTicket(ticketId)
      .then(setTicket)
      .catch((e) => {
        if ((e as { status?: number }).status === 404) setNotFound(true);
      });
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    setNotFound(false);
    fetchTicket(ticketId)
      .then((tk) => { if (live) setTicket(tk); })
      .catch((e) => { if (live && (e as { status?: number }).status === 404) setNotFound(true); })
      .finally(() => { if (live) setLoading(false); });
    fetchUsers().then((u) => { if (live) setUsers(u); }).catch(() => { if (live) setUsers([]); });
    return () => { live = false; };
  }, [ticketId]);

  // Live updates: a realtime event touching THIS ticket bumps the thread to refetch.
  const ticketRef = useRef(ticketId);
  useEffect(() => { ticketRef.current = ticketId; });
  useEffect(() => {
    const unsubscribe = subscribe((e) => {
      if (e.ticketId && e.ticketId === ticketRef.current) {
        setRtSignal((n) => n + 1);
        reload();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  if (loading) {
    return (
      <>
        <div className="grid min-h-0 flex-1 place-items-center"><Spinner /></div>
      </>
    );
  }
  if (notFound || !ticket) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
          <AlertTriangle className="size-7 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">That ticket doesn't exist or isn't visible.</p>
          <Button variant="outline" size="sm" onClick={() => void navigate({ to: "/tickets" })}>
            Back to tickets
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <ThreadPane
          ticket={ticket}
          users={users}
          refreshKey={rtSignal}
          focused
          onBack={() => void navigate({ to: "/tickets" })}
          onMutated={reload}
        />
      </div>
    </>
  );
}
