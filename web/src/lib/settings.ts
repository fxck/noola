import { api } from "@/lib/api";

// AI & Model settings client — a tenant configures which LLM provider drafts
// replies. The stored API key is write-only: the server never returns it, only
// `hasKey` (whether one is on file). Tenant is server-authoritative from the token.

export type ModelProvider = "managed" | "openai" | "anthropic" | "custom";

export interface ModelSettings {
  provider: ModelProvider;
  /** OpenAI-compatible base URL — only meaningful for the "custom" provider. */
  endpoint: string | null;
  /** Model id, e.g. "gpt-4o-mini" / "claude-3-5-sonnet-latest" / a custom id. */
  model: string | null;
  /** Whether an encrypted key is stored. The key itself is never returned. */
  hasKey: boolean;
}

/**
 * PUT body. `apiKey` is write-only: omit or send "" to keep the existing key,
 * send a non-empty value to replace it. `provider: "managed"` clears the config.
 */
export interface ModelSettingsInput {
  provider: ModelProvider;
  endpoint?: string;
  model?: string;
  apiKey?: string;
}

export interface ModelTestResult {
  ok: boolean;
  error?: string;
}

export const PROVIDER_OPTIONS: { value: ModelProvider; label: string }[] = [
  { value: "managed", label: "Built-in assistant (managed)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

/** Sensible model default/placeholder per provider. */
export const MODEL_PLACEHOLDER: Record<ModelProvider, string> = {
  managed: "",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  custom: "e.g. llama-3.1-70b-instruct",
};

/** Per-provider model menu for the editable model combobox (D1). Free-text entry stays
 *  allowed — these are only a starting menu so a silent typo can't break every AI draft.
 *  Managed/custom have no fixed catalog, so the combobox falls back to plain free-text there. */
export const MODEL_SUGGESTIONS: Record<ModelProvider, string[]> = {
  managed: [],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3"],
  anthropic: [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-3-5-sonnet-latest",
  ],
  custom: [],
};

// ── Settings layout (D10) ─────────────────────────────────────────────────────
// One shared width contract so sibling settings panels stop jumping width as you move
// between them: list-style panels share the wider measure, pure narrow forms the tighter.
export const SETTINGS_PANEL = "mx-auto w-full max-w-3xl p-6";
export const SETTINGS_PANEL_NARROW = "mx-auto w-full max-w-2xl p-6";

export const DEFAULT_SETTINGS: ModelSettings = {
  provider: "managed",
  endpoint: null,
  model: null,
  hasKey: false,
};

export async function fetchModelSettings(): Promise<ModelSettings> {
  return api<ModelSettings>("/settings/model");
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettings> {
  return api<ModelSettings>("/settings/model", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** Runs a live reachability probe against the currently SAVED config. The api()
 *  client sends an application/json content-type, so an explicit body is required —
 *  Fastify rejects an empty body under that content-type. */
export async function testModelSettings(): Promise<ModelTestResult> {
  return api<ModelTestResult>("/settings/model/test", { method: "POST", body: "{}" });
}

// ── Translation (Wave 4) ─────────────────────────────────────────────────────

export interface TranslationSettings {
  /** The workspace's own language (ISO-639-1). Agent-facing text renders in this. */
  workspaceLocale: string;
  /** Master switch — when on, foreign customer messages/replies bridge through the model. */
  autoTranslate: boolean;
  updatedAt: string | null;
}

export interface TranslationSettingsInput {
  workspaceLocale: string;
  autoTranslate: boolean;
}

/** The languages the detector can name — offered in the workspace-language picker. `null` names the
 *  "leave undetected" nothing; every value here maps 1:1 to the server's LANGUAGE_NAMES. */
export const WORKSPACE_LANGUAGES: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "ru", label: "Russian" },
  { value: "uk", label: "Ukrainian" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "ar", label: "Arabic" },
];

// ISO-639-1 → display name (superset of the picker: also the script-detected languages a customer
// might write in but a workspace wouldn't be set to). Mirrors the server's LANGUAGE_NAMES.
const LANGUAGE_NAMES: Record<string, string> = {
  ...Object.fromEntries(WORKSPACE_LANGUAGES.map((l) => [l.value, l.label])),
  he: "Hebrew",
  el: "Greek",
};

/** Human-readable language name for an ISO code, falling back to the upper-cased code / "Unknown". */
export function localeName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

export async function fetchTranslationSettings(): Promise<TranslationSettings> {
  return api<TranslationSettings>("/settings/translation");
}

export async function saveTranslationSettings(input: TranslationSettingsInput): Promise<TranslationSettings> {
  return api<TranslationSettings>("/settings/translation", { method: "PUT", body: JSON.stringify(input) });
}

// ── Auto-tagging config (STUDIO-SEEDED-FLOWS.md #1) ───────────────────────────
// The keyword→tag rules + AI toggle that project into the managed 'autotag' Studio flows.
export interface TagRule {
  id: string;
  tag: string;
  keywords: string[];
  enabled: boolean;
  position: number;
}
export interface TagConfig {
  aiEnabled: boolean;
  rules: TagRule[];
}
export interface TagRuleInput {
  tag: string;
  keywords: string[];
  enabled: boolean;
}
export interface TagConfigInput {
  aiEnabled: boolean;
  rules: TagRuleInput[];
}

export async function fetchTagConfig(): Promise<TagConfig> {
  return api<TagConfig>("/settings/tag-rules");
}

export async function saveTagConfig(input: TagConfigInput): Promise<TagConfig> {
  return api<TagConfig>("/settings/tag-rules", { method: "PUT", body: JSON.stringify(input) });
}

// ── Classification config (0087) — topics + Slack reactions + additive risk ───────
export const SLACK_TRIAGE_ACTIONS = ["close", "reopen", "snooze", "assign_me", "unassign"] as const;
export type SlackTriageAction = (typeof SLACK_TRIAGE_ACTIONS)[number];

export interface TopicRule { id?: string; topic: string; keywords: string[]; enabled: boolean; position?: number }
export interface ReactionEntry { emoji: string; action: SlackTriageAction }
export interface RiskKeywordRule { id?: string; riskTag: string; keywords: string[]; enabled: boolean }

export interface ClassificationConfig {
  topicRules: TopicRule[];
  reactionMap: ReactionEntry[];
  riskKeywords: RiskKeywordRule[];
  /** Built-in risk tags that always fire (read-only reference for the additive UI). */
  builtinRiskTags: string[];
}
export interface ClassificationConfigInput {
  topicRules: { topic: string; keywords: string[]; enabled: boolean }[];
  reactionMap: { emoji: string; action: SlackTriageAction }[];
  riskKeywords: { riskTag: string; keywords: string[]; enabled: boolean }[];
}

export async function fetchClassificationConfig(): Promise<ClassificationConfig> {
  return api<ClassificationConfig>("/settings/classification");
}
export async function saveClassificationConfig(input: ClassificationConfigInput): Promise<ClassificationConfig> {
  return api<ClassificationConfig>("/settings/classification", { method: "PUT", body: JSON.stringify(input) });
}

// ── Discord ops-mirror (forum mirror) ────────────────────────────────────────

export interface MirrorFilter {
  priorities?: string[];
  tags?: string[];
  topics?: string[];
  teamIds?: string[];
  channels?: string[];
}
export interface DiscordMirrorBinding {
  id: string;
  guild_id: string;
  forum_channel_id: string;
  enabled: boolean;
  responder_role_id: string | null;
  attribution_mode: "team" | "collaborator";
  attribution_name: string | null;
  filter: MirrorFilter;
}
export interface DiscordMirrorGuild {
  id: string;
  forums: { id: string; name: string }[];
  roles: { id: string; name: string }[];
}
export interface DiscordMirrorConfig {
  bindings: DiscordMirrorBinding[];
  guilds: DiscordMirrorGuild[];
  botOnline: boolean;
}
export interface DiscordMirrorBindingInput {
  guildId: string;
  forumChannelId: string;
  enabled: boolean;
  responderRoleId?: string | null;
  attributionMode: "team" | "collaborator";
  attributionName?: string | null;
  filter: MirrorFilter;
}

export async function fetchDiscordMirrorConfig(): Promise<DiscordMirrorConfig> {
  return api<DiscordMirrorConfig>("/settings/discord-mirror");
}
export async function saveDiscordMirrorBindings(bindings: DiscordMirrorBindingInput[]): Promise<{ bindings: DiscordMirrorBinding[] }> {
  return api<{ bindings: DiscordMirrorBinding[] }>("/settings/discord-mirror", { method: "PUT", body: JSON.stringify({ bindings }) });
}

// ── Discord customer channels (VIP, D5) ──────────────────────────────────────

export interface DiscordChannelBinding {
  guild_id: string;
  channel_id: string;
  mode: "staffed" | "community" | "off";
  require_thread: boolean;
  thread_per_message: boolean;
  kind: string;
  autoreply_mode: "off" | "suggest" | "auto" | null;
  company_id: string | null;
  company_name: string | null;
}
export interface DiscordChannelsConfig {
  bindings: DiscordChannelBinding[];
  guilds: {
    id: string;
    channels: { id: string; name: string; kind: "text" | "forum" }[];
    roles: { id: string; name: string }[];
    /** Members with these roles are the team — never treated as customers. */
    teamRoleIds: string[];
  }[];
  botOnline: boolean;
}

/** Save a guild's identity classification (team roles). Members holding any of these roles are
 *  internal teammates: their Discord messages never open tickets or count as customer turns. */
export async function saveDiscordTeamRoles(guildId: string, teamRoleIds: string[]): Promise<void> {
  await api("/discord/classification", { method: "POST", body: JSON.stringify({ guildId, teamRoleIds }) });
}
export interface DiscordChannelBindingInput {
  guildId: string;
  channelId: string;
  /** "forum" = community-forum intake: every post becomes its own ticket. */
  kind?: "text" | "forum";
  mode: "staffed" | "community" | "off";
  requireThread: boolean;
  threadPerMessage: boolean;
  companyId?: string | null;
  /** Per-binding AI override — null inherits the workspace autoreply policy. */
  autoreplyMode?: "off" | "suggest" | "auto" | null;
}

export async function fetchDiscordChannelsConfig(): Promise<DiscordChannelsConfig> {
  return api<DiscordChannelsConfig>("/settings/discord-channels");
}
export async function saveDiscordChannelBindings(bindings: DiscordChannelBindingInput[]): Promise<{ bindings: DiscordChannelBinding[] }> {
  return api<{ bindings: DiscordChannelBinding[] }>("/settings/discord-channels", { method: "PUT", body: JSON.stringify({ bindings }) });
}

// ── Channels catalog (Wave 4) ────────────────────────────────────────────────

export interface ChannelStatus {
  id: string;
  label: string;
  direction: "inbound" | "outbound" | "both";
  status: "live" | "stub";
  blurb: string;
  connections: number;
  connected: boolean;
  credentialed: boolean;
}

export async function fetchChannels(): Promise<ChannelStatus[]> {
  return (await api<{ channels: ChannelStatus[] }>("/channels")).channels;
}

// ── Self-serve channel connections (0092) ────────────────────────────────────

export interface ChannelConnection {
  id: string;
  channel: string;
  label: string;
  config: Record<string, unknown>;
  active: boolean;
  hasSecret: boolean;
  createdAt: string;
}

export async function fetchChannelConnections(): Promise<ChannelConnection[]> {
  return (await api<{ connections: ChannelConnection[] }>("/channel-connections")).connections;
}

export async function saveTelegramConnection(botToken: string, label?: string): Promise<ChannelConnection> {
  return (await api<{ connection: ChannelConnection }>("/channel-connections", {
    method: "POST",
    body: JSON.stringify({ channel: "telegram", botToken, ...(label ? { label } : {}) }),
  })).connection;
}

export async function saveWhatsAppConnection(input: { token: string; phoneId: string; verifyToken?: string; label?: string }): Promise<ChannelConnection> {
  return (await api<{ connection: ChannelConnection }>("/channel-connections", {
    method: "POST",
    body: JSON.stringify({ channel: "whatsapp", ...input }),
  })).connection;
}

export async function deleteChannelConnection(id: string): Promise<void> {
  await api(`/channel-connections/${id}`, { method: "DELETE" });
}

// ── Slack workspace connections (inbound events → tenant) ────────────────────

export interface SlackConnection {
  id: string;
  team_id: string;
  bot_token: string; // masked by the api
  active: boolean;
  answer_bot?: boolean;
}

export async function fetchSlackConnections(): Promise<SlackConnection[]> {
  return (await api<{ connections: SlackConnection[] }>("/slack/connections")).connections;
}

export async function saveSlackConnection(input: { team_id: string; bot_token: string; answer_bot?: boolean }): Promise<SlackConnection> {
  return (await api<{ connection: SlackConnection }>("/slack/connections", {
    method: "POST",
    body: JSON.stringify(input),
  })).connection;
}

export async function deleteSlackConnection(id: string): Promise<void> {
  await api(`/slack/connections/${id}`, { method: "DELETE" });
}

// ── Workspace governance policies (0092) ─────────────────────────────────────

export interface TenantPolicies {
  retentionDays: number | null;
  ipAllowlist: string[];
  require2fa: boolean;
}

export async function fetchPolicies(): Promise<TenantPolicies> {
  return api<TenantPolicies>("/settings/policies");
}

export async function savePolicies(patch: Partial<TenantPolicies>): Promise<TenantPolicies> {
  return api<TenantPolicies>("/settings/policies", { method: "PUT", body: JSON.stringify(patch) });
}
