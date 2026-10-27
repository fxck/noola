defmodule NoolaEdgeWeb.TicketChannel do
  use Phoenix.Channel

  alias NoolaEdgeWeb.Presence

  # tickets:<tenantId> — the tenant is taken from the AUTHENTICATED socket
  # (assigned in UserSocket.connect from the verified token), never trusted from
  # the topic. The first clause matches only when the topic's tenant_id is the
  # SAME bound variable as the socket's — i.e. a session may join its own
  # tenant's stream and nothing else. "new_event" broadcasts (from
  # NoolaEdge.NatsConsumer via Endpoint.broadcast/3) fan out automatically.
  @impl true
  def join("tickets:" <> tenant_id, _payload, %{assigns: %{tenant_id: tenant_id}} = socket) do
    # Track presence once we're inside the channel process (Presence.track must
    # run from the tracked pid, not from join/3 which runs before it's linked).
    send(self(), :after_join)
    {:ok, socket}
  end

  # Any other tenant topic on this socket is a cross-tenant attempt — refuse.
  def join("tickets:" <> _other, _payload, _socket) do
    {:error, %{reason: "forbidden"}}
  end

  # Register this session in the tenant's presence set and hand the joining
  # client the current roster. Phoenix pushes "presence_diff" for changes after.
  @impl true
  def handle_info(:after_join, socket) do
    {:ok, _ref} =
      Presence.track(socket, socket.assigns.user_id, %{
        user_id: socket.assigns.user_id,
        name: socket.assigns.name,
        online_at: System.system_time(:second) |> DateTime.from_unix!() |> DateTime.to_iso8601(),
        viewing: nil,
        typing: nil
      })

    push(socket, "presence_state", Presence.list(socket))
    {:noreply, socket}
  end

  # Client updates what it's viewing / whether it's typing. Both are nullable
  # strings; a missing key defaults to nil (clears the field).
  @impl true
  def handle_in("presence_update", payload, socket) do
    viewing = Map.get(payload, "viewing")
    typing = Map.get(payload, "typing")

    {:ok, _ref} =
      Presence.update(socket, socket.assigns.user_id, fn meta ->
        Map.merge(meta, %{viewing: viewing, typing: typing})
      end)

    {:reply, :ok, socket}
  end
end
