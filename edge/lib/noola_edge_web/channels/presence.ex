defmodule NoolaEdgeWeb.Presence do
  @moduledoc """
  Per-tenant presence: who is online / which ticket they're viewing / whether
  they're typing. Backed by `Phoenix.Presence` (CRDT over `NoolaEdge.PubSub`),
  so every node in the edge cluster converges on the same view and clients get
  `presence_diff` pushes automatically as members join, leave, or update.

  Tracked on the `tickets:<tenant_id>` topic keyed by `user_id`, so presence is
  naturally scoped to a tenant's stream — the same server-authoritative boundary
  the channel join enforces.
  """
  use Phoenix.Presence,
    otp_app: :noola_edge,
    pubsub_server: NoolaEdge.PubSub
end
