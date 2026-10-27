defmodule NoolaEdgeWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :noola_edge

  # Browser clients open a WebSocket at /socket/websocket?vsn=2.0.0 and speak
  # the Phoenix v2 serializer (JSON arrays [join_ref, ref, topic, event, payload]).
  # Phoenix implements that protocol natively via UserSocket.
  socket "/socket", NoolaEdgeWeb.UserSocket,
    websocket: true,
    longpoll: false

  # Public messenger-widget socket. No session — the end customer has none. Connect carries the
  # tenant's public widget key; the topic is widget:<conversationId> (a client-generated UUID).
  # It is a read-only relay of agent replies (NatsConsumer fans widget-channel messages here), so
  # the trust model matches the public HTTP widget lanes: the conversationId IS the capability.
  socket "/widget-socket", NoolaEdgeWeb.WidgetSocket,
    websocket: [check_origin: false],
    longpoll: false

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head

  plug NoolaEdgeWeb.Router
end
