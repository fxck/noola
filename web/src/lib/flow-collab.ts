import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Socket } from "phoenix";
import type { FlowGraph, FlowNode, FlowEdge } from "@/lib/automations";
import { EDGE_URL } from "@/lib/realtime";

// Collaborative canvas transport (Lane 4b). A custom Yjs provider over the Phoenix edge's
// `flow:<automationId>` channel — same yjs sync + awareness wire format the edge's yrs NIF
// (Yex.Sync / Yex.Awareness) speaks, so the two interoperate. We DON'T use y-websocket: the
// edge is Phoenix Channels, so sync/awareness ride two named channel events, base64-framed:
//   • "sync"      — [MSG_SYNC, <sync sub-message>]   (step1 / step2 / update)
//   • "awareness" — a raw awareness update
// The edge is server-authoritative (holds the canonical doc, persists it); this is a thin peer.

const MSG_SYNC = 0;
// The transaction origin tag for updates we APPLIED from the network — so our own
// doc.on("update") handler never echoes a remote update straight back.
const REMOTE = "remote";

export interface CollabPeer {
  clientId: number;
  userId?: string;
  name: string;
  color: string;
}

export interface FlowCollab {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  nodes: Y.Map<FlowNode>;
  edges: Y.Map<FlowEdge>;
  /** Reconcile a full graph into the shared maps (add/update/remove) in one transaction. */
  writeGraph: (g: FlowGraph) => void;
  /** Current graph as a plain object (for the canvas). */
  readGraph: () => FlowGraph;
  disconnect: () => void;
}

const COLORS = ["#f472b6", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#fb923c"];
export function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function b64encode(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function connectFlow(
  automationId: string,
  token: string | null,
  identity: { id?: string; name: string },
  onStatus?: (s: "connecting" | "live" | "down") => void,
): FlowCollab {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const nodes = doc.getMap<FlowNode>("nodes");
  const edges = doc.getMap<FlowEdge>("edges");

  awareness.setLocalStateField("user", {
    id: identity.id,
    name: identity.name,
    color: colorFor(identity.id || identity.name),
  });

  onStatus?.("connecting");
  const socket = new Socket(`${EDGE_URL}/socket`, {
    params: { token: token ?? "" },
    reconnectAfterMs: (tries) => [500, 1000, 2000, 5000][tries - 1] ?? 5000,
  });
  socket.onError(() => onStatus?.("down"));
  socket.connect();
  const channel = socket.channel(`flow:${automationId}`, {});

  // ── outbound: local doc edits → "sync" update frame ──
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return; // applied-from-network; don't echo
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    channel.push("sync", { b: b64encode(encoding.toUint8Array(enc)) });
  };
  doc.on("update", onDocUpdate);

  // ── inbound: "sync" frame → apply, reply if the protocol asks ──
  channel.on("sync", ({ b }: { b: string }) => {
    const dec = decoding.createDecoder(b64decode(b));
    const enc = encoding.createEncoder();
    decoding.readVarUint(dec); // MSG_SYNC
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.readSyncMessage(dec, enc, doc, REMOTE);
    if (encoding.length(enc) > 1) channel.push("sync", { b: b64encode(encoding.toUint8Array(enc)) });
  });

  // ── awareness both ways ──
  const onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE) return;
    const changed = added.concat(updated, removed);
    channel.push("awareness", { b: b64encode(awarenessProtocol.encodeAwarenessUpdate(awareness, changed)) });
  };
  awareness.on("update", onAwareness);
  channel.on("awareness", ({ b }: { b: string }) => {
    awarenessProtocol.applyAwarenessUpdate(awareness, b64decode(b), REMOTE);
  });

  channel
    .join()
    .receive("ok", () => {
      onStatus?.("live");
      // Kick the handshake: send our step1 so the server replies with its state (step2).
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, doc);
      channel.push("sync", { b: b64encode(encoding.toUint8Array(enc)) });
      // Push our presence.
      channel.push("awareness", {
        b: b64encode(awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])),
      });
    })
    .receive("error", () => onStatus?.("down"));

  const writeGraph = (g: FlowGraph) => {
    doc.transact(() => {
      const nIds = new Set((g.nodes ?? []).map((n) => n.id));
      for (const id of Array.from(nodes.keys())) if (!nIds.has(id)) nodes.delete(id);
      for (const n of g.nodes ?? []) nodes.set(n.id, n);
      const eKey = (e: FlowEdge) => `${e.from}::${e.when ?? ""}::${e.to}`;
      const eIds = new Set((g.edges ?? []).map(eKey));
      for (const id of Array.from(edges.keys())) if (!eIds.has(id)) edges.delete(id);
      for (const e of g.edges ?? []) edges.set(eKey(e), e);
    }); // local origin (undefined) → broadcasts
  };

  const readGraph = (): FlowGraph => ({
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  });

  const disconnect = () => {
    try {
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "local");
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwareness);
      channel.leave();
      socket.disconnect();
      doc.destroy();
    } catch {
      /* ignore */
    }
  };

  return { doc, awareness, nodes, edges, writeGraph, readGraph, disconnect };
}

/** Flatten awareness states into a peer list (excluding me), collapsing a user's tabs by id. */
export function collabPeers(awareness: awarenessProtocol.Awareness): CollabPeer[] {
  const seen = new Set<string>();
  const out: CollabPeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const user = (state as { user?: { id?: string; name: string; color: string } }).user;
    if (!user) return;
    const key = user.id ? `u:${user.id}` : `c:${clientId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ clientId, userId: user.id, name: user.name, color: user.color });
  });
  return out;
}
