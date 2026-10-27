defmodule NoolaEdge.FlowStore do
  @moduledoc """
  Persistence for a flow's collaborative document, mediated by the api.

  The edge holds no database — it owns sessions/tenants via the api (see
  `NoolaEdge.Auth`) and, for the same reason, persists a room's Yjs document
  through the api's internal endpoint rather than talking to Postgres directly.
  The encoded CRDT doc is the source of truth for reconnecting collaborators; a
  plain `{nodes, edges}` projection is written alongside so the automations
  engine can run the graph headlessly.

  Calls are authorised by a shared `EDGE_SHARED_SECRET` (service-to-service), and
  every request is scoped to a server-authoritative `tenant_id` — the edge never
  trusts a client's tenant, so a room can only ever touch its own tenant's doc.
  """
  require Logger

  @doc "Load a room's persisted doc + graph. Returns {:ok, %{doc: binary|nil, graph: map|nil}} | :error."
  def load(tenant_id, automation_id) do
    with {:ok, api_url} <- cfg(:api_url),
         {:ok, secret} <- cfg(:edge_secret) do
      url = String.to_charlist("#{api_url}/internal/flow-doc/#{automation_id}?tenantId=#{tenant_id}")
      headers = [{~c"x-edge-secret", String.to_charlist(secret)}]

      case :httpc.request(:get, {url, headers}, [timeout: 4_000, connect_timeout: 3_000], []) do
        {:ok, {{_v, 200, _r}, _h, body}} -> parse_load(body)
        {:ok, {{_v, 404, _r}, _h, _b}} -> {:ok, %{doc: nil, graph: nil}}
        other ->
          Logger.warning("FlowStore.load failed: #{inspect(other)}")
          :error
      end
    else
      _ -> :error
    end
  end

  @doc "Persist a room's encoded doc + projected graph."
  def save(tenant_id, automation_id, doc_binary, graph) do
    with {:ok, api_url} <- cfg(:api_url),
         {:ok, secret} <- cfg(:edge_secret) do
      url = String.to_charlist("#{api_url}/internal/flow-doc/#{automation_id}")
      headers = [{~c"x-edge-secret", String.to_charlist(secret)}]
      payload =
        Jason.encode!(%{
          "tenantId" => tenant_id,
          "doc" => Base.encode64(doc_binary),
          "graph" => graph
        })

      req = {url, headers, ~c"application/json", payload}

      case :httpc.request(:put, req, [timeout: 5_000, connect_timeout: 3_000], []) do
        {:ok, {{_v, s, _r}, _h, _b}} when s in 200..299 -> :ok
        other ->
          Logger.warning("FlowStore.save failed: #{inspect(other)}")
          :error
      end
    else
      _ -> :error
    end
  end

  defp parse_load(body) do
    case Jason.decode(to_string(body)) do
      {:ok, map} ->
        doc =
          case map["doc"] do
            b when is_binary(b) and b != "" -> Base.decode64!(b)
            _ -> nil
          end

        {:ok, %{doc: doc, graph: map["graph"]}}

      _ ->
        :error
    end
  end

  defp cfg(key) do
    case Application.get_env(:noola_edge, key) do
      v when is_binary(v) and v != "" -> {:ok, v}
      _ -> :error
    end
  end
end
