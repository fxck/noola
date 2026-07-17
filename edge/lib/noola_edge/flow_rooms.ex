defmodule NoolaEdge.FlowRooms do
  @moduledoc """
  Registry + dynamic supervisor for `FlowRoom` processes. `ensure/2` returns the
  live room for a `{tenant_id, automation_id}`, starting it on first use and
  reusing it thereafter (a race between two joiners resolves to the winner).
  """
  alias NoolaEdge.FlowRoom

  def child_specs do
    [
      {Registry, keys: :unique, name: NoolaEdge.FlowRegistry},
      {DynamicSupervisor, strategy: :one_for_one, name: NoolaEdge.FlowRoomSup}
    ]
  end

  @spec ensure(String.t(), String.t()) :: {:ok, pid()} | {:error, term()}
  def ensure(tenant_id, automation_id) do
    case DynamicSupervisor.start_child(
           NoolaEdge.FlowRoomSup,
           {FlowRoom, tenant_id: tenant_id, automation_id: automation_id}
         ) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      other -> other
    end
  end
end
