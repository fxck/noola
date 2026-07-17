defmodule NoolaEdge.Auth.Stub do
  @moduledoc "Test verifier: fixed token→tenant map, no network."
  @behaviour NoolaEdge.Auth

  @tenant_a "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  @tenant_b "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

  def tenant_a, do: @tenant_a
  def tenant_b, do: @tenant_b

  @impl true
  def verify_token("valid-a"),
    do: {:ok, %{tenant_id: @tenant_a, user_id: "user-a", name: "Alice"}}

  def verify_token("valid-b"),
    do: {:ok, %{tenant_id: @tenant_b, user_id: "user-b", name: "Bob"}}

  def verify_token(_), do: :error
end
