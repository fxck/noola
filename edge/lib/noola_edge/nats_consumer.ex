defmodule NoolaEdge.NatsConsumer do
  @moduledoc """
  Bridges NATS -> Phoenix Channels.

  Opens a resilient `gnat` connection to the managed `broker` service,
  core-subscribes to `noola.events.*`, and for each JSON event envelope
  broadcasts the decoded map to `tickets:<tenantId>` as `"new_event"`.

  Connection is lazy + self-healing: if the broker is not yet reachable at
  boot (or the link drops later), it retries on an interval instead of
  crashing the supervision tree.
  """
  use GenServer
  require Logger

  @subject "noola.events.*"
  @reconnect_ms 2_000

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    # Connect out-of-band so a cold broker never blocks/crashes boot.
    send(self(), :connect)
    {:ok, %{conn: nil, sub: nil}}
  end

  @impl true
  def handle_info(:connect, state) do
    case connect() do
      {:ok, conn} ->
        {:ok, sub} = Gnat.sub(conn, self(), @subject)
        Process.monitor(conn)
        Logger.info("NatsConsumer connected to broker, subscribed to #{@subject}")
        {:noreply, %{state | conn: conn, sub: sub}}

      {:error, reason} ->
        Logger.warning(
          "NatsConsumer connect failed (#{inspect(reason)}); retrying in #{@reconnect_ms}ms"
        )

        Process.send_after(self(), :connect, @reconnect_ms)
        {:noreply, %{state | conn: nil, sub: nil}}
    end
  end

  # A NATS message on noola.events.<tenantId>.
  @impl true
  def handle_info({:msg, %{body: body}}, state) do
    case decode_envelope(body) do
      {:ok, %{"tenantId" => tenant_id} = envelope} when is_binary(tenant_id) ->
        NoolaEdgeWeb.Endpoint.broadcast("tickets:" <> tenant_id, "new_event", envelope)
        Logger.info("relayed #{envelope["type"]} -> tickets:#{tenant_id} (msg #{envelope["id"]})")
        maybe_relay_widget(envelope)

      {:ok, envelope} ->
        Logger.warning("Dropping NATS event without string tenantId: #{inspect(envelope)}")

      {:error, reason} ->
        Logger.warning("Dropping undecodable NATS event: #{inspect(reason)}")
    end

    {:noreply, state}
  end

  # The gnat connection went down — schedule a reconnect.
  def handle_info({:DOWN, _ref, :process, _pid, reason}, state) do
    Logger.warning("NATS connection down (#{inspect(reason)}); reconnecting")
    Process.send_after(self(), :connect, @reconnect_ms)
    {:noreply, %{state | conn: nil, sub: nil}}
  end

  def handle_info(_other, state), do: {:noreply, state}

  # --- helpers ---

  # A widget-channel AGENT reply also fans out to the customer's public widget socket
  # (widget:<externalChannelId>) as "message", so the embedded messenger shows it live instead of
  # polling. Only agent turns matter to the customer (their own message is already on screen).
  defp maybe_relay_widget(%{"data" => %{"channelType" => "widget", "authorType" => "agent"} = data}) do
    case data["externalChannelId"] do
      cid when is_binary(cid) and cid != "" ->
        NoolaEdgeWeb.Endpoint.broadcast("widget:" <> cid, "message", %{
          "id" => data["messageId"],
          "body" => data["body"]
        })

      _ ->
        :ok
    end
  end

  defp maybe_relay_widget(_envelope), do: :ok

  defp decode_envelope(body) do
    case Jason.decode(body) do
      {:ok, %{} = envelope} -> {:ok, envelope}
      {:ok, other} -> {:error, {:not_a_map, other}}
      {:error, _} = err -> err
    end
  end

  # Pattern A (Zerops NATS wiring): host + port as the server, user + pass as
  # options. Never hand-compose nats://user:pass@host — that triggers a
  # double-auth Authorization Violation.
  defp connect do
    settings =
      %{
        host: System.get_env("NATS_HOST", "broker"),
        port: nats_port(),
        username: System.get_env("NATS_USER"),
        password: System.get_env("NATS_PASS")
      }
      |> Enum.reject(fn {_k, v} -> is_nil(v) end)
      |> Map.new()

    Gnat.start_link(settings)
  rescue
    e -> {:error, e}
  end

  defp nats_port do
    case System.get_env("NATS_PORT") do
      nil -> 4222
      "" -> 4222
      p -> String.to_integer(p)
    end
  end
end
