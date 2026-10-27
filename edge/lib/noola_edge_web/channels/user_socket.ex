defmodule NoolaEdgeWeb.UserSocket do
  use Phoenix.Socket

  # Every "tickets:<tenantId>" topic is served by TicketChannel.
  channel "tickets:*", NoolaEdgeWeb.TicketChannel

  # "flow:<automationId>" — collaborative canvas (Yjs sync + awareness). Tenant is
  # taken from the socket, never the topic, so a room is always tenant-scoped.
  channel "flow:*", NoolaEdgeWeb.FlowChannel

  # Authenticated connect: the client MUST supply a session Bearer token as the
  # `token` connect param. We verify it against the api (which owns sessions) and
  # pin the resulting tenant onto the socket. Everything downstream (channel join)
  # trusts socket.assigns.tenant_id, never the client's topic string — so a
  # session can only ever reach its own tenant's stream.
  @impl true
  def connect(params, socket, _connect_info) do
    with token when is_binary(token) <- params["token"],
         {:ok, %{tenant_id: tenant_id, user_id: user_id, name: name}} <-
           NoolaEdge.Auth.verify_token(token) do
      {:ok, assign(socket, tenant_id: tenant_id, user_id: user_id, name: name)}
    else
      _ -> :error
    end
  end

  # Socket id keyed on the user enables targeted disconnects (e.g. on logout).
  @impl true
  def id(%{assigns: %{user_id: user_id}}), do: "user_socket:#{user_id}"
  def id(_socket), do: nil
end
