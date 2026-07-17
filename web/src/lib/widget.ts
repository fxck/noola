import { api } from "@/lib/api";

// Messenger widget keys + personalization (Settings → Messenger). A widget key is PUBLIC
// (embedded in a customer's site, domain-allowlisted) — not a secret like an API key. Its
// `config` drives the embedded launcher/panel (accent, greeting, launcher corner, which tabs
// show) and is served to the widget at runtime via GET /public/config.

export interface WidgetTabs {
  home: boolean;
  messages: boolean;
  help: boolean;
}

export interface WidgetConfig {
  accent: string;
  title: string;
  greeting: string;
  position: "right" | "left";
  tabs: WidgetTabs;
}

export interface WidgetKey {
  publicKey: string;
  label: string | null;
  allowedDomains: string[];
  enabled: boolean;
  createdAt: string;
  config: WidgetConfig;
}

export const WIDGET_CONFIG_DEFAULTS: WidgetConfig = {
  accent: "#4f46e5",
  title: "Ask us anything",
  greeting: "Hi there 👋  Ask a question for an instant answer, or browse our help center.",
  position: "right",
  tabs: { home: true, messages: true, help: true },
};

export async function fetchWidgetKeys(): Promise<WidgetKey[]> {
  return (await api<{ keys: WidgetKey[] }>("/widget-keys")).keys;
}

export async function createWidgetKey(input: {
  label?: string;
  allowedDomains?: string[];
}): Promise<WidgetKey> {
  return (await api<{ key: WidgetKey }>("/widget-keys", { method: "POST", body: JSON.stringify(input) })).key;
}

export async function updateWidgetKey(
  publicKey: string,
  input: { label?: string | null; allowedDomains?: string[]; config?: Partial<WidgetConfig> },
): Promise<WidgetKey> {
  return (
    await api<{ key: WidgetKey }>(`/widget-keys/${encodeURIComponent(publicKey)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    })
  ).key;
}

export async function deleteWidgetKey(publicKey: string): Promise<void> {
  await api<{ ok: true }>(`/widget-keys/${encodeURIComponent(publicKey)}`, { method: "DELETE" });
}
