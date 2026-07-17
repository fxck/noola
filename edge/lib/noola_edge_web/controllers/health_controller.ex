defmodule NoolaEdgeWeb.HealthController do
  use Phoenix.Controller, formats: [:json]

  # GET /health -> 200 {"status":"ok"}. Kept dependency-free so readiness
  # never gates on NATS/PubSub being up.
  def index(conn, _params) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{status: "ok"}))
  end
end
