import Config

# runtime.exs is evaluated at boot for every environment (dev via
# `mix phx.server`, prod via the release binary), so all env-derived
# config lives here. Zerops injects env vars as OS env vars.

port = String.to_integer(System.get_env("PORT") || "4000")

# The api owns sessions; the edge verifies client tokens by calling its
# /auth/me over the internal network. Set per-env in zerops.yaml
# (edgedev → http://apidev:3000, edgestage → http://apistage:3000).
if api_url = System.get_env("API_INTERNAL_URL") do
  config :noola_edge, :api_url, api_url
end

# Shared service-to-service secret for the api's internal /flow-doc persistence
# endpoint (collaborative canvas). Project-level Zerops secret, injected into both
# the edge and the api so only the edge can read/write a room's stored doc.
if edge_secret = System.get_env("EDGE_SHARED_SECRET") do
  config :noola_edge, :edge_secret, edge_secret
end

# SECRET_KEY_BASE is a project-level Zerops secret (auto-injected, 64 chars).
# Do not generate our own. Only enforce presence when actually serving.
secret_key_base =
  System.get_env("SECRET_KEY_BASE") ||
    if config_env() == :prod do
      raise """
      environment variable SECRET_KEY_BASE is missing.
      It is provisioned as a Zerops project secret.
      """
    else
      # Dev fallback so a bare `mix phx.server` without the platform env
      # still boots locally. On Zerops dev the project secret is present.
      String.duplicate("0", 64)
    end

config :noola_edge, NoolaEdgeWeb.Endpoint,
  # MUST bind 0.0.0.0 on Zerops — localhost => 502 behind the L7 balancer.
  http: [ip: {0, 0, 0, 0}, port: port],
  secret_key_base: secret_key_base,
  # Slice 1 has no auth; browser clients join from arbitrary origins.
  check_origin: false

# The release runs `bin/noola_edge start`, which does NOT auto-serve the
# endpoint the way `mix phx.server` does — turn the server on explicitly.
if config_env() == :prod do
  config :noola_edge, NoolaEdgeWeb.Endpoint, server: true
end
