defmodule NoolaEdgeWeb.TicketChannelTest do
  use NoolaEdgeWeb.ChannelCase, async: false

  alias NoolaEdgeWeb.{UserSocket, TicketChannel}
  alias NoolaEdge.Auth.Stub

  setup do
    # A socket authenticated as tenant A (via the stub verifier).
    {:ok, socket} = connect(UserSocket, %{"token" => "valid-a"})
    %{socket: socket}
  end

  test "join accepts the session's OWN tenant topic", %{socket: socket} do
    assert {:ok, _reply, joined} =
             subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_a()}")

    assert joined.assigns.tenant_id == Stub.tenant_a()
  end

  test "join REJECTS a foreign tenant topic (the cross-tenant guard)", %{socket: socket} do
    assert {:error, %{reason: "forbidden"}} =
             subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_b()}")
  end

  test "a tenant-A socket that joined its stream receives its own broadcast", %{socket: socket} do
    {:ok, _reply, _joined} =
      subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_a()}")

    envelope = %{"type" => "message.created", "tenantId" => Stub.tenant_a(), "ticketId" => "t1"}
    NoolaEdgeWeb.Endpoint.broadcast("tickets:#{Stub.tenant_a()}", "new_event", envelope)

    assert_push "new_event", ^envelope
  end

  test "joining tracks the user in presence and pushes the current roster", %{socket: socket} do
    {:ok, _reply, joined} =
      subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_a()}")

    # The joining client gets the initial roster with itself listed.
    assert_push "presence_state", state
    assert %{"user-a" => %{metas: [meta | _]}} = state
    assert meta.user_id == "user-a"
    assert meta.name == "Alice"
    assert is_binary(meta.online_at)
    assert meta.viewing == nil
    assert meta.typing == nil

    # And presence is queryable on the channel socket.
    assert %{"user-a" => _} = NoolaEdgeWeb.Presence.list(joined)
  end

  test "presence_update merges viewing/typing and emits a presence_diff", %{socket: socket} do
    {:ok, _reply, joined} =
      subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_a()}")

    assert_push "presence_state", _state
    # The initial track fans out its own join diff — consume it before updating.
    assert_push "presence_diff", %{joins: %{"user-a" => _}}

    ref = push(joined, "presence_update", %{"viewing" => "ticket-42", "typing" => "ticket-42"})
    assert_reply ref, :ok

    assert_push "presence_diff", %{joins: %{"user-a" => %{metas: [meta | _]}}}
    assert meta.viewing == "ticket-42"
    assert meta.typing == "ticket-42"
  end

  test "presence_update tolerates missing keys (defaults to nil)", %{socket: socket} do
    {:ok, _reply, joined} =
      subscribe_and_join(socket, TicketChannel, "tickets:#{Stub.tenant_a()}")

    assert_push "presence_state", _state
    # The initial track fans out its own join diff — consume it before updating.
    assert_push "presence_diff", %{joins: %{"user-a" => _}}

    ref = push(joined, "presence_update", %{})
    assert_reply ref, :ok

    assert_push "presence_diff", %{joins: %{"user-a" => %{metas: [meta | _]}}}
    assert meta.viewing == nil
    assert meta.typing == nil
  end
end
