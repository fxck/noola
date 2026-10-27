import Config

# Runtime endpoint config (http bind, secret_key_base, server: true) is in
# runtime.exs — evaluated when the release boots.
config :logger, level: :info
