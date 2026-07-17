defmodule NoolaEdgeWeb.ErrorJSON do
  # Renders JSON error bodies. By default returns the HTTP status message,
  # e.g. render("404.json", _) -> %{errors: %{detail: "Not Found"}}.
  def render(template, _assigns) do
    %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
  end
end
