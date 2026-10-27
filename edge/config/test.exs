import Config

# Test endpoint: no listener (server: false) — ChannelTest drives sockets
# in-process. secret_key_base just has to be present and long enough.
config :noola_edge, NoolaEdgeWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: String.duplicate("t", 64),
  server: false,
  check_origin: false

# Verify tokens with an in-memory stub instead of calling the api over HTTP.
config :noola_edge, :auth_verifier, NoolaEdge.Auth.Stub

# Quiet the NatsConsumer's expected reconnect chatter (no broker in test).
config :logger, level: :error
