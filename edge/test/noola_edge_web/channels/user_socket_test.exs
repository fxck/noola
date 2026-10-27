defmodule NoolaEdgeWeb.UserSocketTest do
  use NoolaEdgeWeb.ChannelCase, async: false

  alias NoolaEdgeWeb.UserSocket
  alias NoolaEdge.Auth.Stub

  test "rejects a connection with no token" do
    assert :error = connect(UserSocket, %{})
  end

  test "rejects a connection with an empty token" do
    assert :error = connect(UserSocket, %{"token" => ""})
  end

  test "rejects a connection with an invalid token" do
    assert :error = connect(UserSocket, %{"token" => "bogus"})
  end

  test "accepts a valid token and pins the verified tenant onto the socket" do
    assert {:ok, socket} = connect(UserSocket, %{"token" => "valid-a"})
    assert socket.assigns.tenant_id == Stub.tenant_a()
    assert socket.assigns.user_id == "user-a"
    assert socket.assigns.name == "Alice"
  end
end
