defmodule NoolaEdgeWeb.WidgetSocket do
  use Phoenix.Socket

  # widget:<conversationId> — the public messenger widget's live lane. Served by WidgetChannel.
  channel "widget:*", NoolaEdgeWeb.WidgetChannel

  # Anonymous connect: the end customer has no session. We require a non-empty widget key param
  # (format-checked only — the authoritative key + origin checks run on every public HTTP action
  # in the api). The key is pinned on the socket so the channel can echo it if needed. This lane
  # is read-only (agent replies fanned in by NatsConsumer), so no tenant is derived here.
  @impl true
  def connect(params, socket, _connect_info) do
    case params["key"] do
      key when is_binary(key) and key != "" ->
        {:ok, assign(socket, widget_key: key)}

      _ ->
        :error
    end
  end

  # Anonymous — no per-user socket id (nothing to target for forced disconnect).
  @impl true
  def id(_socket), do: nil
end
