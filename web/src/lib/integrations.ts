import { api } from "@/lib/api";

// Client for the unified integrations API (Agent Studio). Outbound connectors an automation
// can notify through, plus a read-only overview of the tenant's connected inbound channels.
// Secrets are write-only (server masks reads to has_secret); admin-gated mutations surface a
// 403 ApiError for non-admins.

export type IntegrationKind = "slack" | "discord" | "email" | "http";

export interface Integration {
  id: string;
  kind: IntegrationKind | string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: string; // 'ok' | 'error' | 'unconfigured'
  lastError: string | null;
  lastCheckedAt: string | null;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelsOverview {
  slack: number;
  discord: number;
  email: number;
  widget: number;
  webhooks: number;
}

export interface IntegrationInput {
  kind: IntegrationKind;
  name: string;
  config?: Record<string, unknown>;
  secret?: string;
  enabled?: boolean;
}

/** List the tenant's connectors + the connected-channels overview. */
export async function fetchIntegrations(): Promise<{ integrations: Integration[]; channels: ChannelsOverview }> {
  return api<{ integrations: Integration[]; channels: ChannelsOverview }>("/integrations");
}

export async function createIntegration(input: IntegrationInput): Promise<Integration> {
  return (await api<{ integration: Integration }>("/integrations", { method: "POST", body: JSON.stringify(input) })).integration;
}

/** Patch a connector. Omit `secret` to keep the stored credential; send a new value to replace it. */
export async function updateIntegration(id: string, patch: Partial<IntegrationInput>): Promise<Integration> {
  return (await api<{ integration: Integration }>(`/integrations/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).integration;
}

export async function deleteIntegration(id: string): Promise<void> {
  await api(`/integrations/${id}`, { method: "DELETE" });
}

/** Health-check a connector by dispatching a test payload; returns the outcome. */
export async function testIntegration(id: string): Promise<{ ok: boolean; error?: string }> {
  return api<{ ok: boolean; error?: string }>(`/integrations/${id}/test`, { method: "POST" });
}
