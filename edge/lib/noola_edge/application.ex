defmodule NoolaEdge.Application do
  # See https://hexdocs.pm/elixir/Application.html
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        # PubSub backs Endpoint.broadcast/3 and Channel fan-out.
        {Phoenix.PubSub, name: NoolaEdge.PubSub},
        # Per-tenant presence (who's online / viewing / typing) — rides PubSub,
        # so it must start after it and before the Endpoint that serves channels.
        NoolaEdgeWeb.Presence
      ] ++
        # Registry + dynamic supervisor for collaborative FlowRoom processes.
        NoolaEdge.FlowRooms.child_specs() ++
        [
          # The web endpoint (Bandit) — /socket websocket + /health.
          NoolaEdgeWeb.Endpoint,
          # NATS consumer: subscribes noola.events.* and re-broadcasts to channels.
          NoolaEdge.NatsConsumer
        ]

    opts = [strategy: :one_for_one, name: NoolaEdge.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration on application restarts.
  @impl true
  def config_change(changed, _new, removed) do
    NoolaEdgeWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
