defmodule NoolaEdgeWeb.ChannelCase do
  @moduledoc "Test case for Phoenix channel/socket tests."
  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import NoolaEdgeWeb.ChannelCase

      # The endpoint every socket/channel test builds against.
      @endpoint NoolaEdgeWeb.Endpoint
    end
  end
end
