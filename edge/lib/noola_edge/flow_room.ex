defmodule NoolaEdge.FlowRoom do
  @moduledoc """
  Authoritative CRDT room for one automation's collaborative graph.

  One process per `{tenant_id, automation_id}` holds the canonical `Yex.Doc`
  (maps `nodes` / `edges`) plus a `Yex.Awareness` for presence. It mirrors
  studio's Node relay (server/yjs.ts) but server-authoritative in Elixir via the
  yrs NIF:

    • the doc is loaded from persistence before the first client syncs (else the
      empty in-memory doc would win the first sync and drop the saved graph);
    • an incoming `sync_step1` is answered with a `sync_step2` diff to that
      client only; a `sync_step2` / `sync_update` is applied and fanned out to
      the room's PubSub topic (peers) — Yjs updates are idempotent, so echoing
      to the sender is a harmless no-op;
    • awareness updates are applied (so late joiners get a full snapshot) and
      relayed;
    • edits are persisted debounced (encoded doc + a `{nodes, edges}` projection
      the automations engine can run) and flushed on idle shutdown.

  The channel (`FlowChannel`) owns the socket + auth; this process owns the doc.
  """
  use GenServer, restart: :temporary
  require Logger
  alias NoolaEdge.FlowStore

  @save_debounce_ms 2_000
  @idle_ms 900_000

  # ── client API ──
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: via(opts[:tenant_id], opts[:automation_id]))
  end

  def via(tenant_id, automation_id),
    do: {:via, Registry, {NoolaEdge.FlowRegistry, {tenant_id, automation_id}}}

  def topic(tenant_id, automation_id), do: "flowroom:#{tenant_id}:#{automation_id}"

  @doc "The initial sync-step1 to push to a joining client (server's state vector)."
  def step1(pid), do: GenServer.call(pid, :step1)

  @doc "The full awareness snapshot for a joining client, or nil if nobody's present."
  def awareness_snapshot(pid), do: GenServer.call(pid, :awareness_snapshot)

  @doc "Process one inbound sync message; returns {:reply, binary} (direct reply) or :noreply."
  def sync(pid, submsg), do: GenServer.call(pid, {:sync, submsg})

  @doc "Apply + relay an inbound awareness update."
  def awareness(pid, update), do: GenServer.cast(pid, {:awareness, update})

  # ── GenServer ──
  @impl true
  def init(opts) do
    doc = Yex.Doc.new()
    {:ok, aw} = Yex.Awareness.new(doc)
    Yex.Awareness.clean_local_state(aw)

    state = %{
      doc: doc,
      awareness: aw,
      tenant_id: opts[:tenant_id],
      automation_id: opts[:automation_id],
      topic: topic(opts[:tenant_id], opts[:automation_id]),
      save_ref: nil,
      idle_ref: nil
    }

    {:ok, arm_idle(state), {:continue, :load}}
  end

  @impl true
  def handle_continue(:load, state) do
    case FlowStore.load(state.tenant_id, state.automation_id) do
      {:ok, %{doc: doc}} when is_binary(doc) ->
        Yex.apply_update(state.doc, doc)

      {:ok, %{graph: graph}} when is_map(graph) ->
        seed_from_graph(state.doc, graph)

      _ ->
        :ok
    end

    {:noreply, state}
  end

  @impl true
  def handle_call(:step1, _from, state) do
    {:ok, s1} = Yex.Sync.get_sync_step1(state.doc)
    {:ok, bin} = Yex.Sync.message_encode({:sync, s1})
    {:reply, bin, arm_idle(state)}
  end

  def handle_call(:awareness_snapshot, _from, state) do
    reply =
      case Yex.Awareness.get_client_ids(state.awareness) do
        [] ->
          nil

        ids ->
          case Yex.Awareness.encode_update(state.awareness, ids) do
            {:ok, bin} -> bin
            _ -> nil
          end
      end

    {:reply, reply, state}
  end

  def handle_call({:sync, {:sync_step1, sv}}, _from, state) do
    {:ok, step2} = Yex.Sync.get_sync_step2(state.doc, sv)
    {:ok, bin} = Yex.Sync.message_encode({:sync, step2})
    {:reply, {:reply, bin}, arm_idle(state)}
  end

  def handle_call({:sync, {tag, update}}, _from, state) when tag in [:sync_step2, :sync_update] do
    :ok = Yex.apply_update(state.doc, update)
    {:ok, bin} = Yex.Sync.message_encode({:sync, {:sync_update, update}})
    Phoenix.PubSub.broadcast(NoolaEdge.PubSub, state.topic, {:flow_relay, "sync", bin})
    {:reply, :noreply, state |> schedule_save() |> arm_idle()}
  end

  def handle_call({:sync, _other}, _from, state), do: {:reply, :noreply, state}

  @impl true
  def handle_cast({:awareness, update}, state) do
    Yex.Awareness.apply_update(state.awareness, update)
    Phoenix.PubSub.broadcast(NoolaEdge.PubSub, state.topic, {:flow_relay, "awareness", update})
    {:noreply, arm_idle(state)}
  end

  @impl true
  def handle_info(:save, state) do
    persist(state)
    {:noreply, %{state | save_ref: nil}}
  end

  def handle_info(:idle, state) do
    persist(state)
    {:stop, :normal, state}
  end

  @impl true
  def terminate(_reason, state) do
    persist(state)
    :ok
  end

  # ── internals ──
  defp schedule_save(%{save_ref: nil} = state),
    do: %{state | save_ref: Process.send_after(self(), :save, @save_debounce_ms)}

  defp schedule_save(state), do: state

  defp arm_idle(state) do
    if state.idle_ref, do: Process.cancel_timer(state.idle_ref)
    %{state | idle_ref: Process.send_after(self(), :idle, @idle_ms)}
  end

  defp persist(state) do
    with {:ok, doc_bin} <- Yex.encode_state_as_update(state.doc) do
      FlowStore.save(state.tenant_id, state.automation_id, doc_bin, project(state.doc))
    end
  end

  defp project(doc) do
    %{
      "nodes" => map_values(Yex.Doc.get_map(doc, "nodes")),
      "edges" => map_values(Yex.Doc.get_map(doc, "edges"))
    }
  end

  defp map_values(ymap) do
    ymap |> Yex.Map.to_json() |> Map.values()
  end

  defp seed_from_graph(doc, graph) do
    nodes = List.wrap(graph["nodes"])
    edges = List.wrap(graph["edges"])

    Yex.Doc.transaction(doc, fn ->
      nm = Yex.Doc.get_map(doc, "nodes")
      for n <- nodes, is_map(n), is_binary(n["id"]), do: Yex.Map.set(nm, n["id"], n)
      em = Yex.Doc.get_map(doc, "edges")
      for e <- edges, is_map(e), is_binary(e["id"]), do: Yex.Map.set(em, e["id"], e)
    end)
  end
end
