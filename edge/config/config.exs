# General application configuration compiled into the release.
# Runtime values (http bind, secret_key_base) live in runtime.exs.
import Config

config :noola_edge,
  generators: [timestamp_type: :utc_datetime]

# Endpoint: Bandit adapter, PubSub server used by Endpoint.broadcast/3,
# JSON-only error rendering (no HTML/assets in this edge service).
config :noola_edge, NoolaEdgeWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: NoolaEdgeWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: NoolaEdge.PubSub

config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for Phoenix JSON encoding/decoding.
config :phoenix, :json_library, Jason

# Import environment specific config (dev.exs / prod.exs).
import_config "#{config_env()}.exs"
