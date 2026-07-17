defmodule NoolaEdgeWeb.WidgetChannel do
  use Phoenix.Channel

  # widget:<conversationId> — the public messenger widget subscribes here to receive agent
  # replies the instant they're sent (NatsConsumer broadcasts "message" for widget-channel
  # message.created events). Read-only: the widget never pushes into this channel (it posts to
  # the api's public HTTP lanes); joins always succeed for any conversation id on a key-verified
  # socket. The conversationId is a client-generated UUID and is itself the capability.
  @impl true
  def join("widget:" <> _conversation_id, _payload, socket) do
    {:ok, socket}
  end

  # Ignore any inbound client push — this lane is server→client only.
  @impl true
  def handle_in(_event, _payload, socket) do
    {:noreply, socket}
  end
end
