import { useCallback, useEffect, useRef, useState } from "react";
import { type FlowGraph } from "@/lib/automations";
import { connectFlow, collabPeers, type FlowCollab, type CollabPeer } from "@/lib/flow-collab";

export type CollabStatus = "off" | "connecting" | "live" | "down";

/**
 * Bind an automation's canvas to the shared Yjs doc on the edge. When `enabled`, connects to
 * `flow:<automationId>`, exposes the live graph + a writer, and the peer facepile. The edge is
 * authoritative and seeds the room from automations.graph; if the room comes up empty (a linear
 * rule with no saved graph) the client seeds it from `seedGraph` — safe to do from every client
 * because node/edge ids are deterministic, so concurrent seeds converge instead of doubling.
 */
export function useFlowCollab(opts: {
  automationId: string | null;
  enabled: boolean;
  token: string | null;
  identity: { id?: string; name: string };
  seedGraph: FlowGraph;
}): {
  graph: FlowGraph;
  onGraphChange: (g: FlowGraph) => void;
  peers: CollabPeer[];
  status: CollabStatus;
} {
  const { automationId, enabled, token, identity, seedGraph } = opts;
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [] });
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [status, setStatus] = useState<CollabStatus>("off");
  const ref = useRef<FlowCollab | null>(null);
  const seedRef = useRef(seedGraph);
  seedRef.current = seedGraph;

  useEffect(() => {
    if (!enabled || !automationId) {
      setStatus("off");
      return;
    }
    const collab = connectFlow(automationId, token, identity, setStatus);
    ref.current = collab;

    const refresh = () => setGraph(collab.readGraph());
    collab.nodes.observe(refresh);
    collab.edges.observe(refresh);
    const onAw = () => setPeers(collabPeers(collab.awareness));
    collab.awareness.on("change", onAw);

    // Seed the room from the single-player graph if it comes up empty after the first sync.
    const seedTimer = setTimeout(() => {
      const seed = seedRef.current;
      if (collab.nodes.size === 0 && (seed.nodes?.length ?? 0) > 0) collab.writeGraph(seed);
    }, 600);

    return () => {
      clearTimeout(seedTimer);
      collab.nodes.unobserve(refresh);
      collab.edges.unobserve(refresh);
      collab.awareness.off("change", onAw);
      collab.disconnect();
      ref.current = null;
      setStatus("off");
      setPeers([]);
      setGraph({ nodes: [], edges: [] });
    };
    // identity is stable per session; reconnect only on target/enable/token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, automationId, token]);

  const onGraphChange = useCallback((g: FlowGraph) => {
    ref.current?.writeGraph(g);
    setGraph(g); // optimistic; the observe confirms
  }, []);

  return { graph, onGraphChange, peers, status };
}
