import Config

# The http bind (0.0.0.0:PORT) and secret_key_base are set in runtime.exs
# so they apply identically to `mix phx.server` (dev) and the release (prod).
config :noola_edge, NoolaEdgeWeb.Endpoint,
  # No auth in slice 1: accept websocket joins from any origin.
  check_origin: false,
  code_reloader: false,
  debug_errors: true,
  watchers: []

config :logger, :console, format: "[$level] $message\n"

config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
