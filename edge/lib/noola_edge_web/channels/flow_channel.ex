defmodule NoolaEdgeWeb.FlowChannel do
  @moduledoc """
  Realtime collaboration for one automation's canvas graph — topic
  `flow:<automationId>`. Auth + tenant come from the socket (`UserSocket`
  verified the Bearer token against the api); the room is keyed by that
  server-authoritative `tenant_id` plus the automation id from the topic, so a
  session can only ever reach a graph under its own tenant (a foreign automation
  id resolves to an empty room in the caller's own tenant namespace — never the
  owner's doc, which lives under a different tenant key + is scoped by the api).

  Wire protocol (both directions), chosen to stay JSON-channel-friendly:
    • event "sync"      — %{"b" => base64(Yex.Sync message)}  (step1/step2/update)
    • event "awareness" — %{"b" => base64(awareness update)}
  The client runs its own Y.Doc + y-protocols awareness and speaks the same
  yjs sync/awareness wire format the yrs NIF produces, so they interoperate.
  """
  use Phoenix.Channel
  require Logger
  alias NoolaEdge.{FlowRooms, FlowRoom}

  @impl true
  def join("flow:" <> automation_id, _params, socket) do
    tenant_id = socket.assigns.tenant_id

    if valid_id?(automation_id) do
      case FlowRooms.ensure(tenant_id, automation_id) do
        {:ok, room} ->
          Phoenix.PubSub.subscribe(NoolaEdge.PubSub, FlowRoom.topic(tenant_id, automation_id))
          send(self(), :after_join)
          {:ok, assign(socket, room: room, automation_id: automation_id)}

        _ ->
          {:error, %{reason: "room_unavailable"}}
      end
    else
      {:error, %{reason: "bad_flow"}}
    end
  end

  def join(_topic, _params, _socket), do: {:error, %{reason: "unauthorized"}}

  @impl true
  def handle_info(:after_join, socket) do
    room = socket.assigns.room
    # Kick off the two-way sync: send the server's state vector (step1). The
    # client answers with a step2 diff and its own step1; we reply in kind.
    push(socket, "sync", %{"b" => Base.encode64(FlowRoom.step1(room))})

    case FlowRoom.awareness_snapshot(room) do
      bin when is_binary(bin) -> push(socket, "awareness", %{"b" => Base.encode64(bin)})
      _ -> :ok
    end

    {:noreply, socket}
  end

  # Fan-out from the room (this socket's own edits echo back harmlessly — Yjs
  # updates are idempotent, and awareness re-apply is a no-op).
  def handle_info({:flow_relay, event, bin}, socket) do
    push(socket, event, %{"b" => Base.encode64(bin)})
    {:noreply, socket}
  end

  @impl true
  def handle_in("sync", %{"b" => b64}, socket) do
    with {:ok, raw} <- Base.decode64(b64),
         {:ok, {:sync, sub}} <- Yex.Sync.message_decode(raw) do
      case FlowRoom.sync(socket.assigns.room, sub) do
        {:reply, bin} -> push(socket, "sync", %{"b" => Base.encode64(bin)})
        _ -> :ok
      end
    else
      _ -> Logger.debug("FlowChannel: dropped malformed sync frame")
    end

    {:noreply, socket}
  end

  def handle_in("awareness", %{"b" => b64}, socket) do
    case Base.decode64(b64) do
      {:ok, raw} -> FlowRoom.awareness(socket.assigns.room, raw)
      _ -> :ok
    end

    {:noreply, socket}
  end

  def handle_in(_event, _payload, socket), do: {:noreply, socket}

  # A room id is an automation UUID — cheap sanity so a junk topic can't spin up a room.
  defp valid_id?(id), do: is_binary(id) and byte_size(id) in 1..64
end
