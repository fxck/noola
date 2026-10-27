defmodule NoolaEdge.Auth do
  @moduledoc """
  Verifies a client's Bearer token against the api's session store.

  The api owns sessions (better-auth is the sole auth authority; the Bearer
  token is a better-auth session token) and is the single authority on which
  tenant a token belongs to. The edge does NOT re-derive the tenant from
  anything the client says — it asks the api `GET /auth/me` with the token and
  trusts the returned `tenantId` (= the session's active organization). This
  keeps the realtime boundary identical to the HTTP boundary: tenant is
  server-authoritative.

  The concrete verifier is swappable via `:auth_verifier` config so tests can
  exercise the socket/channel guards without a live api.
  """

  @callback verify_token(String.t()) ::
              {:ok, %{tenant_id: String.t(), user_id: String.t(), name: String.t()}} | :error

  @doc "Resolve a Bearer token to its tenant, via the configured verifier."
  def verify_token(token), do: impl().verify_token(token)

  defp impl, do: Application.get_env(:noola_edge, :auth_verifier, __MODULE__.Http)

  defmodule Http do
    @moduledoc "Default verifier: calls the api `/auth/me` over the internal network."
    @behaviour NoolaEdge.Auth
    require Logger

    @impl true
    def verify_token(token) when is_binary(token) and token != "" do
      case Application.get_env(:noola_edge, :api_url) do
        nil ->
          Logger.error("Auth.Http: API_INTERNAL_URL not configured — rejecting socket")
          :error

        api_url ->
          request(api_url, token)
      end
    end

    def verify_token(_), do: :error

    defp request(api_url, token) do
      url = String.to_charlist("#{api_url}/auth/me")
      headers = [{~c"authorization", String.to_charlist("Bearer #{token}")}]

      # body_format: :binary is load-bearing — the default charlist body reads each BYTE as a
      # codepoint, so UTF-8 names ("Aleš") mojibake into "AleÅ¡" in every presence label.
      case :httpc.request(:get, {url, headers}, [timeout: 3_000, connect_timeout: 3_000], body_format: :binary) do
        {:ok, {{_v, 200, _r}, _headers, body}} -> parse(body)
        {:ok, {{_v, _status, _r}, _headers, _body}} -> :error
        {:error, reason} ->
          Logger.warning("Auth.Http: /auth/me call failed: #{inspect(reason)}")
          :error
      end
    end

    defp parse(body) do
      case Jason.decode(to_string(body)) do
        {:ok, %{"user" => %{"tenantId" => tid, "id" => uid} = user}}
        when is_binary(tid) and is_binary(uid) ->
          {:ok, %{tenant_id: tid, user_id: uid, name: display_name(user["name"], uid)}}

        _ ->
          :error
      end
    end

    # `name` is an optional presence label; fall back to the user_id when the api
    # omits it or sends a blank/whitespace value.
    defp display_name(name, uid) when is_binary(name) do
      case String.trim(name) do
        "" -> uid
        trimmed -> trimmed
      end
    end

    defp display_name(_name, uid), do: uid
  end
end
