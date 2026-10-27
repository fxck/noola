defmodule NoolaEdgeWeb.Router do
  use Phoenix.Router

  import Plug.Conn
  import Phoenix.Controller

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", NoolaEdgeWeb do
    pipe_through :api

    # Platform readiness + health probe. No downstream calls — see recipe.
    get "/health", HealthController, :index
  end
end
