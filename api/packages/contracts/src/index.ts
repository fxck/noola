import { z } from "zod";

/**
 * The wire seam of the whole system: the JSON envelope the API produces,
 * the outbox carries, and the (polyglot) Phoenix edge consumes. api (TS)
 * and edge (Elixir) share this *shape*, not code — keep both in sync.
 */
export const EventEnvelope = z.object({
  id: z.string(), // outbox row id, as string
  type: z.string(), // e.g. "message.created"
  tenantId: z.guid(),
  ticketId: z.guid(),
  occurredAt: z.string(), // ISO-8601
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const EVENT_TYPES = {
  messageCreated: "message.created",
  ticketCreated: "ticket.created",
  autoreplyJob: "noola.autoreply.job",
  sourceSynced: "noola.source.synced",
  broadcastUpdated: "noola.broadcast.updated",
} as const;

// NATS / JetStream addressing. One subject token per tenant so the edge can
// filter per tenant on the wire.
export const NATS_SUBJECT_PREFIX = "noola.events";
export const NATS_STREAM = "NOOLA_EVENTS";
export const natsSubject = (tenantId: string): string =>
  `${NATS_SUBJECT_PREFIX}.${tenantId}`;
export const NATS_SUBJECT_WILDCARD = `${NATS_SUBJECT_PREFIX}.*`;
export const NATS_STREAM_WILDCARD = `${NATS_SUBJECT_PREFIX}.>`;

/** Inbound synthetic-channel message — the generic API/webhook channel (peer to Discord and email). */
export const SyntheticMessageInput = z.object({
  tenantId: z.guid(),
  ticketId: z.guid().optional(), // reply to existing ticket
  subject: z.string().min(1).max(500).optional(), // for a new ticket
  body: z.string().min(1),
  authorType: z.enum(["customer", "agent"]).default("customer"),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type SyntheticMessageInput = z.infer<typeof SyntheticMessageInput>;

/** Bind a Discord guild (server) to a tenant — the routing seam for the Discord channel.
 *  tenantId is now server-authoritative (the admin's session tenant); the optional body
 *  field is ignored, kept only for backward compatibility. */
export const DiscordLinkInput = z.object({
  guildId: z.string().min(1).max(64),
  tenantId: z.guid().optional(),
});
export type DiscordLinkInput = z.infer<typeof DiscordLinkInput>;

// Discord Phase 6 — register a per-tenant BYO bot (label + bot token). The token is encrypted at
// rest; only a label + verification state is ever read back.
export const DiscordBotInput = z.object({
  label: z.string().max(80).optional(),
  token: z.string().min(20).max(120),
});
export type DiscordBotInput = z.infer<typeof DiscordBotInput>;

/** Bind a tenant support address to a tenant — the routing seam for the email channel.
 *  tenantId is server-authoritative (session tenant); the optional body field is ignored. */
export const EmailLinkInput = z.object({
  address: z.string().email(),
  tenantId: z.guid().optional(),
});
export type EmailLinkInput = z.infer<typeof EmailLinkInput>;

/** Upsert a Slack workspace→tenant connection — the routing seam for the Slack channel.
 *  `team_id` is the workspace id (globally unique across tenants); `bot_token` is the
 *  xoxb- token used for chat.postMessage (write-only in effect — GET masks it to a
 *  has_token flag). `active` toggles the connection. */
export const SlackConnectionInput = z.object({
  team_id: z.string().min(1).max(64),
  bot_token: z.string().max(500).optional(),
  active: z.boolean().optional(),
  /** @mention answer-bot lane on/off (grounded KB answers in-thread, no ticket). */
  answer_bot: z.boolean().optional(),
});
export type SlackConnectionInput = z.infer<typeof SlackConnectionInput>;

/** Agent reply to a ticket; posts back to the ticket's origin channel when external.
 *  `attachmentIds` are pre-uploaded attachments (POST /uploads/attachment) to claim onto this reply. */
export const ReplyInput = z.object({
  body: z.string().min(1).max(10000),
  tenantId: z.guid().optional(),
  attachmentIds: z.array(z.guid()).max(10).optional(),
  /** Which channel the reply goes out on. Omitted → the ticket's current reply channel (the last
   *  inbound customer channel). Set to send on a different channel the contact is reachable on. */
  channel: z.string().min(1).max(40).optional(),
  /** Email replies only: carbon-copy these addresses (reply-all). Other channels ignore it. */
  cc: z.array(z.email()).max(10).optional(),
});
export type ReplyInput = z.infer<typeof ReplyInput>;

/** Ingest a document: filename, its MIME type, and the raw text content. */
export const DocumentInput = z.object({
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1).max(120),
  content: z.string().min(1).max(2_000_000),
});
export type DocumentInput = z.infer<typeof DocumentInput>;

/** Register a live source (connector). `kind` selects the connector; `config` is the
 *  per-kind settings: { url } for the URL/web connector, { repo: "owner/name", branch?,
 *  path?, token? } for GitHub, { channelId, guildId?, limit? } for Discord. Each kind
 *  requires its key config field (url / repo / channelId). */
export const SourceInput = z
  .object({
    kind: z.enum(["url", "github", "discord"]),
    label: z.string().max(300).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    // Auto-refresh cadence in minutes (null/omitted = manual only). Floor 15 min (don't hammer a
    // source), ceiling 30 days. A per-minute scheduler re-syncs due sources.
    refreshIntervalMinutes: z.number().int().min(15).max(43200).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "url" && !(typeof v.config.url === "string" && v.config.url.trim().length > 0)) {
      ctx.addIssue({
        code: "custom",
        message: "config.url is required for kind 'url'",
        path: ["config", "url"],
      });
    }
    if (
      v.kind === "github" &&
      !(typeof v.config.repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(v.config.repo.trim()))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "config.repo ('owner/name') is required for kind 'github'",
        path: ["config", "repo"],
      });
    }
    if (
      v.kind === "discord" &&
      !(typeof v.config.channelId === "string" && v.config.channelId.trim().length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "config.channelId is required for kind 'discord'",
        path: ["config", "channelId"],
      });
    }
  });
export type SourceInput = z.infer<typeof SourceInput>;

/** Create/update a KB article. Update allows partial (all optional). `collection_id`
 *  places the article in a KB collection; explicit null moves it back to uncategorized,
 *  undefined leaves it unchanged. */
export const KbArticleInput = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(100000).optional(),
  collection_id: z.guid().nullable().optional(),
  // KB-CMS lifecycle: draft vs published, and internal (agent grounding only) vs public (help center).
  status: z.enum(["draft", "published"]).optional(),
  visibility: z.enum(["internal", "public"]).optional(),
});
export type KbArticleInput = z.infer<typeof KbArticleInput>;

/** Create/update a KB collection (a "folder" grouping articles). Create requires a name;
 *  update is partial. `color` is a UI accent; `position` orders collections in the tree. */
export const KbCollectionInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().max(40).optional(),
  position: z.number().int().min(0).max(100000).optional(),
});
export type KbCollectionInput = z.infer<typeof KbCollectionInput>;

/** A saved Segment — a named, reusable filter over a resource (contacts for now).
 *  `definition` carries the surface's own filter grammar ({ q?, filters, sort? }) as an
 *  opaque bag; only the owning surface interprets it. Create requires a name; PATCH uses
 *  SegmentInput.partial(). */
export const SegmentInput = z.object({
  name: z.string().min(1).max(120),
  resource: z.string().min(1).max(40).optional(),
  definition: z.record(z.string(), z.unknown()).default({}),
});
export type SegmentInput = z.infer<typeof SegmentInput>;

// --- Public API keys (Wave A extensibility spine) ---
export const API_SCOPES = ["answer", "tickets:read", "tickets:write", "events:write", "scim"] as const;
export const ApiKeyInput = z.object({
  name: z.string().max(120).optional(),
  scopes: z.array(z.enum(API_SCOPES)).max(8).default([]),
});
export type ApiKeyInput = z.infer<typeof ApiKeyInput>;

/** Public JSON answer API request — `key` may also arrive via the x-api-key header. */
export const PublicAnswerInput = z.object({
  question: z.string().min(1).max(4000),
});
export type PublicAnswerInput = z.infer<typeof PublicAnswerInput>;

// --- Macros / canned responses ---
export const MacroInput = z.object({
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(8000),
  shortcut: z.string().max(40).nullish(),
});
export type MacroInput = z.infer<typeof MacroInput>;

// --- Internal notes / side conversations ---
export const NoteInput = z.object({
  body: z.string().min(1).max(8000),
  // Member ids from the composer's mention chips — authoritative loop-in list when present.
  mentionIds: z.array(z.guid()).max(50).optional(),
});
export type NoteInput = z.infer<typeof NoteInput>;

// --- Public tickets API (Wave A) ---
export const PublicTicketInput = z.object({
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(8000),
  channelType: z.string().max(40).optional(),
  externalId: z.string().max(200).optional(),
});
export type PublicTicketInput = z.infer<typeof PublicTicketInput>;

// --- SLA policy ---
export const SlaPolicyInput = z.object({
  firstResponseMins: z.number().int().min(1).max(100000).optional(),
  resolutionMins: z.number().int().min(1).max(1000000).optional(),
  enabled: z.boolean().optional(),
  // Business-hours-aware SLA: when enabled, target clocks only tick during working hours.
  // A fixed weekly schedule (no DST) — tzOffsetMins converts UTC → the workspace's wall clock.
  businessHoursEnabled: z.boolean().optional(),
  tzOffsetMins: z.number().int().min(-720).max(840).optional(),
  workdays: z.array(z.number().int().min(0).max(6)).max(7).optional(), // 0=Sun … 6=Sat
  dayStartMin: z.number().int().min(0).max(1439).optional(),           // minutes past local midnight
  dayEndMin: z.number().int().min(1).max(1440).optional(),
});
export type SlaPolicyInput = z.infer<typeof SlaPolicyInput>;

// --- Bulk ticket actions ---
export const BULK_TICKET_ACTIONS = ["close", "reopen", "assign", "team", "priority", "tag"] as const;
export const BulkTicketInput = z.object({
  ids: z.array(z.guid()).min(1).max(500),
  action: z.enum(BULK_TICKET_ACTIONS),
  value: z.string().max(200).nullish(),
});
export type BulkTicketInput = z.infer<typeof BulkTicketInput>;

// --- CSAT (customer satisfaction) — submitted by the end customer via the public API ---
export const CsatInput = z.object({
  ticketId: z.guid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});
export type CsatInput = z.infer<typeof CsatInput>;

// --- Custom fields — tenant-defined ticket attributes ---
export const CUSTOM_FIELD_TYPES = ["text", "number", "select", "boolean", "date"] as const;
export const CustomFieldDefInput = z.object({
  entity: z.enum(["ticket", "company"]).default("ticket"),
  label: z.string().min(1).max(80),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().max(80)).max(50).optional(),
  key: z.string().max(80).optional(),
});
export type CustomFieldDefInput = z.infer<typeof CustomFieldDefInput>;

export const CustomFieldDefPatch = z.object({
  label: z.string().min(1).max(80).optional(),
  options: z.array(z.string().max(80)).max(50).optional(),
  position: z.number().int().min(0).max(10000).optional(),
});
export type CustomFieldDefPatch = z.infer<typeof CustomFieldDefPatch>;

/** Set one custom-field value on a ticket (empty string clears it). */
export const CustomFieldValueInput = z.object({
  fieldId: z.guid(),
  value: z.string().max(2000),
});
export type CustomFieldValueInput = z.infer<typeof CustomFieldValueInput>;

// --- Ticket types (tenant-defined taxonomy) ---
export const TICKET_TYPE_COLORS = ["slate", "blue", "green", "amber", "red", "violet", "pink", "cyan"] as const;
export const TicketTypeInput = z.object({
  name: z.string().min(1).max(60),
  color: z.enum(TICKET_TYPE_COLORS).optional(),
});
export type TicketTypeInput = z.infer<typeof TicketTypeInput>;
export const TicketTypePatch = z.object({
  name: z.string().min(1).max(60).optional(),
  color: z.enum(TICKET_TYPE_COLORS).optional(),
  position: z.number().int().min(0).max(10000).optional(),
});
export type TicketTypePatch = z.infer<typeof TicketTypePatch>;

// --- NPS (Net Promoter Score) — submitted by the end customer via the public API ---
export const NpsInput = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().max(2000).optional(),
  ticketId: z.guid().optional(),
});
export type NpsInput = z.infer<typeof NpsInput>;

// --- Interactive agent run — invoke the autonomous loop on demand against a ticket ---
export const AgentRunInput = z.object({
  instructions: z.string().max(2000).optional(),
  tools: z.array(z.string().max(40)).max(20).optional(),
  maxSteps: z.number().int().min(1).max(8).optional(),
  // Default is a SAFE dry run (tools report what they would do); live=true actually executes.
  live: z.boolean().optional(),
  // Per-run model override (dogfood L0-F2). Swaps the model NAME within the tenant's hosted
  // provider/key; a managed-baseline tenant ignores it (no hosted model to override).
  model: z.string().max(120).optional(),
});
export type AgentRunInput = z.infer<typeof AgentRunInput>;

// --- Messenger widget: poll a conversation's messages (widget-key auth, public) ---
export const PublicConversationInput = z.object({
  key: z.string().min(1),
  conversationId: z.string().min(1).max(200),
});
export type PublicConversationInput = z.infer<typeof PublicConversationInput>;

/** Update a live source's editable settings — its label and per-kind `config` (sync
 *  scope, cadence, and credentials). `kind` is immutable and not accepted here. A
 *  write-only credential (e.g. github token) is preserved when omitted; sending a new
 *  value replaces it. */
export const SourceUpdateInput = z.object({
  label: z.string().max(300).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  refreshIntervalMinutes: z.number().int().min(15).max(43200).nullable().optional(),
});
export type SourceUpdateInput = z.infer<typeof SourceUpdateInput>;

/** Assign a ticket to a tenant user (assigneeId = null unassigns). */
export const AssignInput = z.object({
  tenantId: z.guid().optional(),
  assigneeId: z.guid().nullable(),
});
export type AssignInput = z.infer<typeof AssignInput>;

// --- Teams — named agent groups: inbox lanes, assignment targets, routing pools ---
export const TeamInput = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().max(8).nullish(),
  /** Full-replace membership list (tenant user ids). Omit to leave membership unchanged. */
  memberIds: z.array(z.guid()).max(200).optional(),
});
export type TeamInput = z.infer<typeof TeamInput>;
export const TeamPatch = TeamInput.partial();
export type TeamPatch = z.infer<typeof TeamPatch>;

/** Move a ticket into a team lane (teamId = null clears it). `autoAssign` also round-robins
 *  an assignee from the team's members in the same transaction. */
export const TicketTeamInput = z.object({
  teamId: z.guid().nullable(),
  autoAssign: z.boolean().optional(),
});
export type TicketTeamInput = z.infer<typeof TicketTeamInput>;

/** Routing v2 — per-agent routing signals (admin). `reassign` (with outOfOffice: true) also
 *  re-routes the agent's open tickets: team tickets round-robin to eligible teammates,
 *  the rest go back to Unassigned. */
export const UserRoutingInput = z.object({
  skills: z.array(z.string().min(1).max(40)).max(20).optional(),
  outOfOffice: z.boolean().optional(),
  /** Auto-return time (ISO): OOO expires at this moment (pools treat the agent as available
   *  again; the flag itself is cleared by read-repair). null/omitted = until turned off. */
  oooUntil: z.string().max(40).nullish(),
  maxOpenTickets: z.number().int().min(1).max(500).nullish(),
  reassign: z.boolean().optional(),
});
export type UserRoutingInput = z.infer<typeof UserRoutingInput>;

/** BYO per-tenant model config. `apiKey` is write-only (omit/empty keeps the stored
 *  key); provider "managed" clears the config back to the built-in baseline. */
export const ModelConfigInput = z.object({
  provider: z.enum(["managed", "openai", "anthropic", "custom"]),
  endpoint: z.string().url().max(500).nullish(),
  model: z.string().min(1).max(200).nullish(),
  apiKey: z.string().max(1000).optional(),
});
export type ModelConfigInput = z.infer<typeof ModelConfigInput>;

// --- Routing & assignment rules — auto-assign new tickets by ordered, condition-matched rules ---
export const ROUTING_STRATEGIES = ["specific", "round_robin", "least_loaded"] as const;
export const ROUTING_FIELDS = ["channel", "subject", "priority", "tag"] as const;
export const ROUTING_OPS = ["eq", "contains"] as const;
export const RoutingConditionInput = z.object({
  field: z.enum(ROUTING_FIELDS),
  op: z.enum(ROUTING_OPS),
  value: z.string().min(1).max(120),
});
export type RoutingConditionInput = z.infer<typeof RoutingConditionInput>;
export const RoutingRuleInput = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().optional(),
  conditions: z.array(RoutingConditionInput).max(10).optional(),
  strategy: z.enum(ROUTING_STRATEGIES).optional(),
  assigneeIds: z.array(z.guid()).max(50).optional(),
  /** Target team: the ticket lands in this team's lane and the pool strategies draw from its
   *  members (assigneeIds is ignored when set). null/omitted = classic agent-pool rule. */
  teamId: z.guid().nullish(),
  /** Skill gate (Routing v2): pool candidates must carry EVERY listed skill. */
  requiredSkills: z.array(z.string().min(1).max(40)).max(10).optional(),
  setPriority: z.enum(["low", "normal", "high", "urgent"]).nullish(),
  addTags: z.array(z.string().max(40)).max(20).optional(),
  position: z.number().int().min(0).max(10000).optional(),
});
export type RoutingRuleInput = z.infer<typeof RoutingRuleInput>;
export const RoutingRulePatch = RoutingRuleInput.partial();
export type RoutingRulePatch = z.infer<typeof RoutingRulePatch>;

// --- Auto satisfaction surveys — auto-deliver CSAT/NPS when a ticket resolves ---
export const SurveySettingsInput = z.object({
  csatEnabled: z.boolean().optional(),
  npsEnabled: z.boolean().optional(),
});
export type SurveySettingsInput = z.infer<typeof SurveySettingsInput>;

// --- Enterprise SSO — per-tenant OIDC/SAML IdP config, routed by email domain ---
export const SSO_PROVIDERS = ["oidc", "saml"] as const;
export const SsoConnectionInput = z.object({
  provider: z.enum(SSO_PROVIDERS).optional(),
  name: z.string().min(1).max(80),
  emailDomain: z.string().min(1).max(200),
  issuer: z.string().max(500).nullish(),
  authorizeUrl: z.string().url().max(500).nullish(),
  tokenUrl: z.string().url().max(500).nullish(),
  // With authorize + token + JWKS all set, the plugin skips runtime OIDC discovery entirely
  // (needsRuntimeDiscovery=false), so no discovery-endpoint trust check applies.
  jwksUrl: z.string().url().max(500).nullish(),
  clientId: z.string().max(300).nullish(),
  clientSecret: z.string().max(500).nullish(),
  enabled: z.boolean().optional(),
});
export type SsoConnectionInput = z.infer<typeof SsoConnectionInput>;
export const SsoConnectionPatch = SsoConnectionInput.partial();
export type SsoConnectionPatch = z.infer<typeof SsoConnectionPatch>;

/** Per-channel autoreply routing: what a given channel does with an evaluated inbound
 *  message. The global mode is a ceiling — a channel entry can only restrict, never
 *  escalate: auto-send takes global mode='auto' AND an explicit per-channel 'auto'
 *  (unlisted channels degrade to suggest_only). 'skip' = don't even draft. */
export const CHANNEL_MODES = ["auto", "suggest_only", "skip"] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

/** Which retrieval surfaces an audience may draw from. 'public' = widget / docs embed /
 *  deflection / public answer API; 'agent' = copilot suggestions + the autoreply gate. */
export const SOURCE_KINDS = ["kb", "thread", "document"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Per-tenant autoreply policy patch (all fields optional). mode gates auto-send;
 *  off = assist only. Guardrails/caps/kill-switch bound what auto-send may do.
 *  min_confidence (nullable) adds a model-confidence floor to the auto-send gate. */
export const AutoreplyPolicyInput = z.object({
  mode: z.enum(["off", "suggest_only", "auto"]).optional(),
  min_agreement: z.number().int().min(0).max(3).optional(),
  min_top_score: z.number().min(0).max(1).optional(),
  channel_modes: z.record(z.string().min(1).max(40), z.enum(CHANNEL_MODES)).optional(),
  min_confidence: z.number().min(0).max(1).nullable().optional(),
  source_scopes: z
    .record(z.enum(["public", "agent"]), z.array(z.enum(SOURCE_KINDS)).max(3))
    .optional(),
  max_auto_per_thread: z.number().int().min(0).max(1000).optional(),
  max_auto_per_hour: z.number().int().min(0).max(100000).optional(),
  kill_switch: z.boolean().optional(),
});
export type AutoreplyPolicyInput = z.infer<typeof AutoreplyPolicyInput>;

/** A directory contact. All fields optional, but at least one IDENTIFYING field
 *  (external_id / email / name / company) must be present — a bare attributes bag
 *  isn't a contact. `email` is format-checked when present; `attributes` is a
 *  free-form bag shallow-merged on upsert. */
export const ContactInput = z
  .object({
    external_id: z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
    name: z.string().max(300).optional(),
    company: z.string().max(300).optional(),
    company_id: z.guid().nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.external_id || v.email || v.name || v.company) || v.company_id !== undefined, {
    message: "at least one of external_id, email, name, company is required",
  });

/** Create/update a company (account record). Create requires a name; update is partial. */
export const CompanyInput = z.object({
  name: z.string().min(1).max(300).optional(),
  domain: z.string().max(300).optional(),
  plan: z.string().max(120).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type CompanyInput = z.infer<typeof CompanyInput>;

/** Create/update a feature request. Create requires a title; status follows the fixed lifecycle. */
export const FeatureRequestInput = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(["open", "planned", "in_progress", "shipped", "declined"]).optional(),
});
export type FeatureRequestInput = z.infer<typeof FeatureRequestInput>;

/** Link a ticket to a feature request as evidence. */
export const FeatureLinkInput = z.object({ ticketId: z.guid() });
export type FeatureLinkInput = z.infer<typeof FeatureLinkInput>;
export type ContactInput = z.infer<typeof ContactInput>;

/** Bulk back-office import — a batch of contacts upserted in one transaction
 *  (idempotent per row on external_id, else email). Capped to keep the txn bounded. */
export const BulkContactsInput = z.object({
  contacts: z.array(ContactInput).min(1).max(1000),
});
export type BulkContactsInput = z.infer<typeof BulkContactsInput>;

/** Directory data-list filtering (the Intercom-grade filter builder). A condition targets
 *  a core column (name/email/company/created_at/updated_at) or an attribute (field
 *  `attr:<key>`), with a per-field operator. `value` is required for the value ops
 *  (is/is_not/contains/starts_with/before/after) and omitted for exists/not_exists.
 *  Compiled to safe parameterized SQL server-side (buildContactWhere). */
export const CONTACT_FILTER_OPS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "exists",
  "not_exists",
  "before",
  "after",
] as const;
export type ContactFilterOp = (typeof CONTACT_FILTER_OPS)[number];

export const CONTACT_SORT_FIELDS = ["name", "email", "company", "created_at", "updated_at"] as const;
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];

export const ContactFilterConditionSchema = z.object({
  field: z.string().min(1).max(160), // core column name, or "attr:<key>"
  op: z.enum(CONTACT_FILTER_OPS),
  value: z.string().max(500).optional(),
});
export type ContactFilterCondition = z.infer<typeof ContactFilterConditionSchema>;

export const ContactFilterConditions = z.array(ContactFilterConditionSchema).max(25);

/** OR groups: each inner array is AND-combined, groups OR together. Compiled by
 *  buildContactWhere as ((g1c1 AND g1c2) OR (g2c1 …)), AND-combined with `conditions`. */
export const ContactFilterConditionGroups = z.array(ContactFilterConditions.min(1)).max(10);

/** Register/update an outbound webhook. `url` must be http(s); `events` is the
 *  subscription filter (omit / empty = all events); `active` toggles delivery. On PATCH
 *  every field is optional (use WebhookInput.partial()). The signing secret is generated
 *  server-side and never part of the input. */
export const WebhookInput = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), { message: "url must be http or https" }),
  events: z.array(z.string().min(1).max(100)).max(50).optional(),
  active: z.boolean().optional(),
});
export type WebhookInput = z.infer<typeof WebhookInput>;

/** Block composer — a broadcast body as an ORDERED BLOCK LIST (Intercom's pattern). Text
 *  blocks hold markdown (lists/code/inline styles live there); merge tags
 *  `{{name|fallback}}` / `{{firstName}}` / `{{email}}` / `{{company}}` / `{{attr:key}}`
 *  are allowed in text, button labels/urls, and the subject — substituted PER RECIPIENT at
 *  send time. `html` is a raw escape hatch (email-only; stripped for chat derivation). */
export const BroadcastBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), md: z.string().max(20000) }),
  z.object({
    type: z.literal("image"),
    url: z.string().url().max(2000),
    alt: z.string().max(300).optional(),
    width: z.number().int().min(40).max(560).optional(), // px inside the 560px frame
  }),
  z.object({
    type: z.literal("button"),
    label: z.string().min(1).max(120),
    url: z.string().max(2000), // not .url() — may carry merge tags
    align: z.enum(["left", "center"]).optional(),
  }),
  z.object({ type: z.literal("divider") }),
  z.object({ type: z.literal("spacer"), height: z.number().int().min(4).max(96).optional() }),
  z.object({ type: z.literal("html"), html: z.string().max(50000) }),
]);
export type BroadcastBlock = z.infer<typeof BroadcastBlock>;
export const BroadcastBlocks = z.array(BroadcastBlock).min(1).max(50);

/** Compose a broadcast: a subject (required), an optional body, ONE channel (defaults to
 *  'email'; validated server-side against the dispatch-capable channel registry), and an
 *  optional `segment` — the SAME contacts filter the directory uses: the flat fields
 *  (q / company / attrKey / attrValue) plus `conditions` (the filter-builder AST,
 *  ContactFilterConditions). An empty/omitted segment targets the whole directory; only
 *  SUBSCRIBED contacts with a deliverable handle for the chosen channel actually receive
 *  (unsubscribed_at suppression, migration 0065). Body/segment default server-side. */
export const BroadcastInput = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().max(100000).optional(),
  channel: z.string().min(1).max(40).optional(),
  // Audience primitive (0078). 'segment' (default) = per-recipient contact-segment send;
  // 'discord_channel' = ONE post to targetRef (a Discord channel id), optionally pinging
  // mentionRoleId and/or rendered asEmbed. Discord is always channel-post (the DM path is retired).
  audienceKind: z.enum(["segment", "discord_channel"]).optional(),
  targetRef: z.string().max(64).nullish(),
  mentionRoleId: z.string().max(64).nullish(),
  asEmbed: z.boolean().optional(),
  segment: z.record(z.string(), z.unknown()).optional(),
  // Optional saved-segment source (segments.ts) — its filter is snapshotted into the broadcast.
  segmentId: z.guid().optional(),
  // Email design template: a built-in slug ('branded'/'personal') or a custom email_templates
  // row id. Validated server-side; defaults to 'branded'. Ignored by chat channels.
  templateId: z.string().min(1).max(64).optional(),
  // Block-composer body (see BroadcastBlock). When present it is the authored content: email
  // renders the blocks; `body` (if also sent) is ignored — the server derives the chat/plain
  // representation from the blocks itself.
  blocks: BroadcastBlocks.optional(),
  // Delivery (0068): 'oneshot' (default) sends now or at sendAt; 'continuous' sends once to
  // each contact the FIRST time they match the audience, until stopAt / manual stop. ISO
  // datetimes, validated server-side (unparseable / past-stopAt → 400).
  mode: z.enum(["oneshot", "continuous"]).optional(),
  sendAt: z.string().max(40).optional(),
  stopAt: z.string().max(40).optional(),
  // Conversion goal (0069): a contact_events name counted when a recipient emits it within
  // goalDays (1–90, default 7) of their send.
  goalEvent: z.string().max(100).optional(),
  goalDays: z.number().int().min(1).max(90).optional(),
  // Send window (0072): scheduler-driven sends (scheduled fire, continuous ticks) only run on
  // these ISO weekdays (1=Mon…7=Sun) between the minute-of-day bounds, in the given UTC offset.
  // All omitted = anytime. "Send now" is an explicit human act and bypasses the window.
  windowDays: z.array(z.number().int().min(1).max(7)).max(7).nullish(),
  windowStartMin: z.number().int().min(0).max(1439).nullish(),
  windowEndMin: z.number().int().min(1).max(1440).nullish(),
  windowTzOffsetMin: z.number().int().min(-840).max(840).nullish(),
});
export type BroadcastInput = z.infer<typeof BroadcastInput>;
/** Draft-only edit — same fields, all optional. The server rejects non-draft targets. */
export const BroadcastPatch = BroadcastInput.partial();
export type BroadcastPatch = z.infer<typeof BroadcastPatch>;


/** Email design tokens — the parameter surface of the react.email frame the designer edits.
 *  All fields optional; the server merges over the chosen built-in's defaults. Colors are
 *  hex strings (validated), sizes are px numbers (bounded so a typo can't produce a 900px H1). */
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex color");
export const EmailTemplateTokens = z.object({
  bodyBackground: hexColor.optional(), // page behind the card
  cardBackground: hexColor.optional(),
  borderColor: hexColor.optional(),
  borderRadius: z.number().int().min(0).max(32).optional(),
  showCard: z.boolean().optional(), // false = plain "personal" letter, no card chrome
  fontFamily: z.string().max(300).optional(),
  textColor: hexColor.optional(),
  mutedColor: hexColor.optional(),
  linkColor: hexColor.optional(),
  h1Size: z.number().int().min(12).max(40).optional(),
  h2Size: z.number().int().min(11).max(32).optional(),
  paragraphSize: z.number().int().min(11).max(24).optional(),
  smallSize: z.number().int().min(9).max(18).optional(),
  subjectSize: z.number().int().min(14).max(40).optional(),
  showSubject: z.boolean().optional(), // render the subject as an in-body headline
  wordmark: z.string().max(60).optional(), // header text; empty string hides the header
  logoUrl: z.string().url().max(2000).or(z.literal("")).optional(), // '' = no logo (wordmark text shows)
  footerText: z.string().max(500).optional(),
  socialLinks: z
    .array(z.object({ label: z.string().min(1).max(40), url: z.string().url().max(2000) }))
    .max(6)
    .optional(),
});
export type EmailTemplateTokens = z.infer<typeof EmailTemplateTokens>;

/** Create/update a custom email template. On PATCH use .partial(). `useForReplies` flags this
 *  template as the tenant's ticket-reply frame (at most one; flagging un-flags the rest). */
export const EmailTemplateInput = z.object({
  name: z.string().min(1).max(120),
  tokens: EmailTemplateTokens.optional(),
  useForReplies: z.boolean().optional(),
});
export type EmailTemplateInput = z.infer<typeof EmailTemplateInput>;

// --- Report builder-lite (Wave 4) — a typed metrics catalog + saved report configs ---
export const REPORT_METRIC_KEYS = [
  "volume", "closed",
  "ttfr_avg", "ttfr_median", "ttfr_p90",
  "ttr_avg", "ttr_median", "ttr_p90",
  "sla_fr_rate", "sla_res_rate",
  "csat_avg", "csat_responses", "nps_score", "deflection_rate",
] as const;
export const ReportConfigInput = z.object({
  metrics: z.array(z.enum(REPORT_METRIC_KEYS)).min(1).max(8),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  groupBy: z.enum(["day", "week"]).optional(),
  teamId: z.guid().optional(),
  agentId: z.guid().optional(),
  compare: z.boolean().optional(),
});
export type ReportConfigInput = z.infer<typeof ReportConfigInput>;

/** Agent persona — the assistant's voice, fed into the draft/autoreply system prompt. All fields
 *  optional (PATCH-style upsert); the tenant keeps prior/default values for unset fields. */
export const PersonaInput = z.object({
  tone: z.string().max(40).optional(),
  signature: z.string().max(500).optional(),
  guardrails: z.string().max(2000).optional(),
  instructions: z.string().max(2000).optional(),
});
export type PersonaInput = z.infer<typeof PersonaInput>;

/** Agent login (email is the global handle across demo tenants). */
export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

/** Self-serve sign-up: create an account AND its first workspace in one step (POST
 *  /auth/signup). `name` is the person; `orgName` names the workspace they'll own. */
export const SignupInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
  orgName: z.string().min(1).max(120),
});
export type SignupInput = z.infer<typeof SignupInput>;

/** Change a member's role (PATCH /members/:id/role). Owner/admin only; the app maps and
 *  clamps to the role vocabulary server-side regardless. */
export const MemberRoleInput = z.object({
  role: z.enum(["owner", "admin", "agent", "viewer"]),
});
export type MemberRoleInput = z.infer<typeof MemberRoleInput>;

/** Create an email invitation (POST /members/invites). */
export const InviteInput = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "agent", "viewer"]).default("agent"),
});
export type InviteInput = z.infer<typeof InviteInput>;

/** Create a shareable invite link (POST /members/invite-links). All fields optional; a bare
 *  POST mints an open-ended agent link. */
export const InviteLinkInput = z.object({
  role: z.enum(["admin", "agent", "viewer"]).default("agent"),
  maxUses: z.number().int().positive().max(10000).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
  allowedDomain: z.string().min(1).max(255).optional(),
});
export type InviteLinkInput = z.infer<typeof InviteLinkInput>;

/** Accept an email invitation (POST /invite/:id/accept) — public. The email comes from the
 *  invitation; the caller sets a password (new account) or supplies the existing one. */
export const AcceptInviteInput = z.object({
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteInput>;

/** Redeem a shareable invite link (POST /join/:token) — public. The link carries no email, so
 *  the joiner supplies it (the link's optional domain allowlist gates which are accepted). */
export const JoinLinkInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
});
export type JoinLinkInput = z.infer<typeof JoinLinkInput>;

/** Public Ask-AI widget query (POST /public/ask). `key` is the site's PUBLIC widget key
 *  — embedded in the page, not a secret; the per-key domain allowlist is the real guard.
 *  v1 is request/response. `escalate` hands off to a human via ingestInbound
 *  (channelType 'widget'); `conversationId` threads one widget conversation to one ticket. */
export const PublicAskInput = z.object({
  key: z.string().min(1).max(200),
  // Empty allowed when files are attached (an attachment-only message). The route enforces
  // "at least one of text/attachments" and skips the AI for attachment-only turns.
  question: z.string().max(2000),
  conversationId: z.string().min(1).max(200).optional(),
  escalate: z.boolean().optional(),
  // Files the visitor attached to this message — base64 data URLs, claimed onto the persisted
  // message and surfaced to the agent (and back into the widget) exactly like agent-reply attachments.
  attachments: z
    .array(z.object({ dataUrl: z.string().min(1).max(28_000_000), filename: z.string().max(200) }))
    .max(5)
    .optional(),
  // Flip the conversation's AI assistant back on (visitor chose "Ask the assistant" after a human
  // handoff). The question on this same call is then answered by the AI as usual.
  resumeAi: z.boolean().optional(),
  // Optional visitor identity — when the widget captures it, escalation links the conversation to a
  // contact (email is the cross-channel unifier), so a later email from the same person threads together.
  email: z.string().email().max(320).optional(),
  name: z.string().max(200).optional(),
});
export type PublicAskInput = z.infer<typeof PublicAskInput>;

/** Mint/update a widget key (authed, tenant-scoped). `allowedDomains` restricts which
 *  site origins may use the key (empty = any origin). */
export const WidgetKeyInput = z.object({
  label: z.string().max(200).optional(),
  allowedDomains: z.array(z.string().min(1).max(253)).max(50).optional(),
});
export type WidgetKeyInput = z.infer<typeof WidgetKeyInput>;

// ── Messenger widget personalization (Settings → Messenger, migration 0074) ──────────
// Per-key config the embedded widget reads at runtime from GET /public/config, so an admin
// can rebrand the launcher/panel without touching the embed snippet. A HEX accent, the panel
// title + Home greeting, the launcher corner, and which of the three tabs are shown.

/** Which messenger tabs are enabled (Home / Messages / Help). */
export const WidgetTabs = z.object({
  home: z.boolean(),
  messages: z.boolean(),
  help: z.boolean(),
});
export type WidgetTabs = z.infer<typeof WidgetTabs>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The resolved, fully-populated widget personalization (what /public/config returns). */
export const WidgetConfig = z.object({
  accent: z.string().regex(HEX_COLOR),
  title: z.string().min(1).max(80),
  greeting: z.string().min(1).max(280),
  position: z.enum(["right", "left"]),
  tabs: WidgetTabs,
});
export type WidgetConfig = z.infer<typeof WidgetConfig>;

/** Defaults applied when a key has no stored personalization (matches the widget's built-ins). */
export const WIDGET_CONFIG_DEFAULTS: WidgetConfig = {
  accent: "#4f46e5",
  title: "Ask us anything",
  greeting: "Hi there 👋  Ask a question for an instant answer, or browse our help center.",
  position: "right",
  tabs: { home: true, messages: true, help: true },
};

/** Partial personalization patch (PATCH /widget-keys/:key). Every field optional; only the
 *  provided ones overwrite. `tabs` shallow-merges so a caller can flip one tab. */
export const WidgetConfigInput = z.object({
  accent: z.string().regex(HEX_COLOR).optional(),
  title: z.string().min(1).max(80).optional(),
  greeting: z.string().min(1).max(280).optional(),
  position: z.enum(["right", "left"]).optional(),
  tabs: WidgetTabs.partial().optional(),
});
export type WidgetConfigInput = z.infer<typeof WidgetConfigInput>;

/** Update a widget key's management fields + personalization (authed, tenant-scoped). */
export const WidgetKeyUpdateInput = z.object({
  label: z.string().max(200).nullable().optional(),
  allowedDomains: z.array(z.string().min(1).max(253)).max(50).optional(),
  config: WidgetConfigInput.optional(),
});
export type WidgetKeyUpdateInput = z.infer<typeof WidgetKeyUpdateInput>;

/** Merge a partial personalization patch over a fully-resolved base config. */
export function mergeWidgetConfig(base: WidgetConfig, patch: WidgetConfigInput | null | undefined): WidgetConfig {
  if (!patch) return base;
  return {
    accent: patch.accent ?? base.accent,
    title: patch.title ?? base.title,
    greeting: patch.greeting ?? base.greeting,
    position: patch.position ?? base.position,
    tabs: { ...base.tabs, ...(patch.tabs ?? {}) },
  };
}

/** Coerce whatever JSON is stored on a key into a complete WidgetConfig (defaults fill gaps). */
export function resolveStoredWidgetConfig(stored: unknown): WidgetConfig {
  const parsed = WidgetConfigInput.safeParse(stored ?? {});
  return mergeWidgetConfig(WIDGET_CONFIG_DEFAULTS, parsed.success ? parsed.data : {});
}

// ── Messenger widget: public identify + track (widget-key-scoped, migration 0074) ────
// The embeddable JS SDK's identity + activity lane. Unlike the api-key /public/events
// (server-to-server, secret), these resolve the tenant from the PUBLIC widget key + the
// per-key domain allowlist — the same trust model as /public/ask.

/** `Noola('boot'|'update', …)` → resolve/upsert the visitor contact + stamp last-seen. When
 *  no email/userId is supplied the visitor is anonymous and nothing is persisted (200 no-op). */
export const PublicIdentifyInput = z.object({
  key: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
  company: z.string().trim().max(200).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  page: z.object({ url: z.string().max(2048).optional(), title: z.string().max(500).optional() }).optional(),
});
export type PublicIdentifyInput = z.infer<typeof PublicIdentifyInput>;

/** `Noola('track', name, metadata?)` → record a custom activity event against the identified
 *  contact (upserted first). Anonymous callers no-op (200, recorded:false). */
export const PublicTrackInput = z.object({
  key: z.string().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PublicTrackInput = z.infer<typeof PublicTrackInput>;

// ── Agent Studio: integrations + automations ─────────────────────────────────
// The unified outbound-connector registry and the rules engine that sends through it.
// Shared shape between api (validation + engine) and the SPA client.

/** A tenant's outbound connector (Settings → Integrations). `kind` selects the transport;
 *  `config` holds per-kind non-secret settings (slack/discord: {}, email: {to}, http:
 *  {url, method?}); `secret` is the write-only credential (Slack/Discord incoming-webhook
 *  URL, or the http HMAC signing key) — stored AES-256-GCM encrypted, masked to has_secret
 *  on reads, and preserved when omitted on update. */
export const INTEGRATION_KINDS = ["slack", "discord", "email", "http"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const IntegrationInput = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().min(1).max(120),
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationInput = z.infer<typeof IntegrationInput>;

/** PATCH /integrations/:id — partial; a changed `kind` is ignored server-side (immutable). */
export const IntegrationUpdateInput = IntegrationInput.partial();
export type IntegrationUpdateInput = z.infer<typeof IntegrationUpdateInput>;

/** A per-node credential binding — any automation action / workflow node / agent tool that
 *  needs a connector references one by id, resolved (loaded + decrypted + kind-checked) through
 *  integrations.resolveCredential(). The notify action carries an inline `integrationId` of this
 *  shape; future node types embed a `credentialRef`. */
export const CredentialRefSchema = z.object({
  integrationId: z.guid(),
});
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/** The automations (rules) engine vocabulary. A rule is WHEN <trigger> IF <conditions>
 *  THEN <actions>. Triggers are domain events fired inline at the mutation choke points
 *  (ingest.ts + the ticket routes). */
export const AUTOMATION_TRIGGERS = [
  // Manual — no event ever fires it; the flow runs only on demand (the Studio "Run" button, or a
  // "run on this ticket" action). Distinct from event triggers so a flow can declare itself an
  // on-demand action rather than sitting idle waiting for an event that never comes.
  "manual",
  "ticket.created",
  "message.received",
  "ticket.closed",
  "ticket.assigned",
  // Milestone 2 — non-ticket triggers. `schedule` fires on a per-automation interval
  // (trigger_config.intervalMinutes) from the in-process minute scheduler; `webhook` fires
  // from an inbound POST /hooks/:token (the parsed body lands in ctx.webhook).
  "schedule",
  "webhook",
  // Dogfood L0 (event-bus) — the domain events every mutation now raises through emitDomainEvent,
  // so more of the product's behavior is automatable without new backend code. Wired at their
  // mutation sites (priority/tags/type via PATCH /tickets/:id, note via the notes route, CSAT/NPS
  // via the public submit lanes). `sla.breached`/`sla.at_risk` are scaffolded here; their emitter
  // (a per-ticket breach detector) lands in L1.
  "ticket.priority_changed",
  "ticket.tagged",
  "ticket.type_changed",
  "note.added",
  "csat.received",
  "nps.received",
  "sla.breached",
  "sla.at_risk",
  // Chat-command triggers. Fire when a customer invokes a channel slash command — the on-demand
  // answer runs regardless, but these let a tenant attach Studio automation logic (tag, notify,
  // route) on top of an ask. Emitted post-ingest via emitDomainEvent with the question's ticketId,
  // so conditions can match on the question body. `discord_slash` = Discord /ask; `slack_slash` = the
  // Slack /ask slash command (same on-demand core, different transport).
  "discord_slash",
  "slack_slash",
  // A knowledge source finished a re-crawl — fires (via emitDomainEvent) after every syncSource with
  // the sourceId + the incremental diff (added/updated/removed) in ctx, so a tenant can attach
  // "new docs synced → tag / notify / run gap-detection" logic. Complements the outbox
  // `noola.source.synced` event (which drives external webhooks / NATS).
  "source.synced",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

/** Per-trigger config bag. Today only `schedule` uses it: intervalMinutes gates how often the
 *  scheduler fires the automation (defaults to 60 when unset). Nullable — other triggers ignore it. */
export const AutomationTriggerConfigSchema = z
  .object({
    intervalMinutes: z.number().int().min(1).max(1_000_000).optional(),
  })
  .nullable();
export type AutomationTriggerConfig = z.infer<typeof AutomationTriggerConfigSchema>;

export const AUTOMATION_CONDITION_OPS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "gt",
  "lt",
  "is_empty",
  "is_not_empty",
  // Dogfood L1 — array/list-aware operators. `contains_any`: the field (array like tags, or a
  // scalar string) matches ANY of the comma-separated values. `in`: the scalar field equals one
  // of the comma-separated values (e.g. `priority in high,urgent`). Makes routing's tag/priority
  // rules expressible as flow conditions.
  "contains_any",
  "in",
] as const;
export type AutomationConditionOp = (typeof AUTOMATION_CONDITION_OPS)[number];

/** One condition: a `field` path into the event context (subject/body/channelType/
 *  authorType/status/assigneeId/whoseTurn), an operator, and a comparison value. */
export const AutomationConditionSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum(AUTOMATION_CONDITION_OPS),
  value: z.string().max(500).default(""),
});
export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;

/** Conditions match ALL or ANY of the list. An empty list matches every event of the
 *  trigger (an unconditional rule). */
export const AutomationConditionsSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(AutomationConditionSchema).max(25).default([]),
});
export type AutomationConditions = z.infer<typeof AutomationConditionsSchema>;

export const AUTOMATION_ACTION_TYPES = [
  "assign",
  "set_status",
  "reply",
  "notify",
  "run",
  "http",
  "rag",
  // Milestone 2 — data-plane actions.
  "kb_upsert",
  "contact_update",
  "broadcast_send",
  // Node-wave — data shaping + web ingestion.
  "set_fields",
  "web_fetch",
  // Chromium-on-runner: render a JS SPA in a headless-browser container and extract its readable
  // text into ctx.web (same shape as web_fetch) — the upgrade over web_fetch's static-only fetch.
  // Reuses `url`; dispatches a `browser`-mode runner job.
  "browser_extract",
  // Dogfood L1 — ticket-mutation + flow-control primitives that make routing/surveys expressible
  // as flows. `assign` gains strategy/pool fields (below). `set_priority`/`add_tags` mutate the
  // ticket taxonomy; `survey` delivers a CSAT/NPS prompt once per dedupe key; `stop` halts the
  // rule (and, at the engine, subsequent rules) — the first-match-wins primitive routing needs.
  "set_priority",
  "add_tags",
  // Auto-tagging (config-driven, no fields). `apply_tag_rules` reads the tenant's tag_rules config
  // live and appends the tag of every keyword rule whose keywords appear in the subject/body — the
  // whole keyword table in ONE step, so the managed 'autotag' flow is a single row, not one-per-tag.
  // `ai_tag` is the optional hosted-model classifier (no-ops on a rule baseline). Both are gated /
  // configured by the Settings → Auto-tagging form (tag_rules + tag_settings.ai_enabled).
  "apply_tag_rules",
  "ai_tag",
  "survey",
  "stop",
  // Escalate — a composite convenience: bump priority (default urgent) + optionally reassign +
  // optionally notify a connector, in one action. Reuses priority/assigneeId/integrationId/text.
  "escalate",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** One typed action; the engine reads the fields relevant to `type`:
 *  assign→{assigneeId}, set_status→{status}, reply→{body}, notify→{integrationId,subject?,text}, run→{cmd},
 *  http→{method,url,headers,httpBody}, rag→{autoReply}, kb_upsert→{kbTitle,kbBody,kbCollectionId?},
 *  contact_update→{contactEmail,contactName?,contactFields?}, broadcast_send→{broadcastSubject,broadcastBody,broadcastSegment?}. */
export const AutomationActionSchema = z.object({
  type: z.enum(AUTOMATION_ACTION_TYPES),
  assigneeId: z.guid().nullable().optional(),
  status: z.enum(["open", "closed"]).optional(),
  body: z.string().max(10000).optional(),
  integrationId: z.guid().optional(),
  subject: z.string().max(500).optional(),
  text: z.string().max(10000).optional(),
  cmd: z.string().max(10000).optional(),
  creds: z.array(z.object({ integrationId: z.guid(), envName: z.string().min(1).max(64) })).max(20).optional(),
  // http action: request line + headers/body, all interpolated with the run context.
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: z.string().max(2000).optional(),
  headers: z.string().max(4000).optional(),
  httpBody: z.string().max(10000).optional(),
  // rag action: when true, the drafted grounded answer is posted as an agent reply.
  autoReply: z.boolean().optional(),
  // kb_upsert action: create + index a KB article.
  kbTitle: z.string().max(300).optional(),
  kbBody: z.string().max(100000).optional(),
  kbCollectionId: z.guid().nullable().optional(),
  // contact_update action: upsert a directory contact keyed on contactEmail. contactFields is a
  // newline `Key: Value` block merged into the contact's attributes.
  contactEmail: z.string().max(320).optional(),
  contactName: z.string().max(300).optional(),
  contactFields: z.string().max(4000).optional(),
  // broadcast_send action: compose + send a broadcast. broadcastSegment is an optional JSON
  // contacts filter (string, interpolated then parsed); empty targets the whole directory.
  broadcastSubject: z.string().max(500).optional(),
  broadcastBody: z.string().max(100000).optional(),
  broadcastSegment: z.string().max(2000).optional(),
  // set_fields action: a newline `Key: Value` block, each value interpolated with the run
  // context, merged into ctx.vars for downstream {{vars.Key}} references (data shaping).
  setFields: z.string().max(8000).optional(),
  // web_fetch action: GET a URL and extract readable text into ctx.web ({url,status,title,text})
  // — feeds kb_upsert for KB ingestion of static pages. (Reuses `url`.)

  // ── Dogfood L1 action fields ──────────────────────────────────────────────
  // assign strategy: `specific` (assigneeId, the classic single-target), or a pool strategy —
  // `round_robin` (a persisted per-cursorKey cursor cycles the pool) / `least_loaded` (fewest
  // open tickets). `assigneeIds` is the pool (empty = every agent); `cursorKey` scopes the
  // round-robin cursor (defaults to strategy+pool; routing seeds pass a per-rule key).
  strategy: z.enum(["specific", "round_robin", "least_loaded"]).optional(),
  assigneeIds: z.array(z.guid()).max(50).optional(),
  cursorKey: z.string().max(120).optional(),
  // assign to a TEAM: sets the ticket's team lane and draws the pool from the team's members
  // (assigneeIds is ignored). Reuses `teamId` name across routing + automations.
  teamId: z.guid().nullish(),
  // Routing v2 skill gate for the pool strategies (candidates must carry every listed skill).
  requiredSkills: z.array(z.string().min(1).max(40)).max(10).optional(),
  // set_priority action: force a ticket priority.
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  // add_tags action: append these tags (deduped) to the ticket's tag array.
  tags: z.array(z.string().min(1).max(60)).max(30).optional(),
  // survey action: deliver a CSAT and/or NPS prompt, once per `dedupeKey` (defaults to the
  // ticket, so a reopen→reclose never double-surveys). `surveyKind` picks which prompt(s).
  surveyKind: z.enum(["csat", "nps", "both"]).optional(),
  dedupeKey: z.string().max(200).optional(),
});
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

// ── Auto-tagging config (0084) ────────────────────────────────────────────────
// A keyword→tag rule + the AI toggle, projected into managed 'autotag' automations. The settings
// form full-replaces the rule set (mirrors the projection's full-replace), so IDs aren't threaded.
export const TagRuleInput = z.object({
  tag: z.string().min(1).max(60),
  keywords: z.array(z.string().min(1).max(80)).max(50).default([]),
  enabled: z.boolean().default(true),
});
export type TagRuleInput = z.infer<typeof TagRuleInput>;

export const TagRulesConfigInput = z.object({
  aiEnabled: z.boolean().default(true),
  rules: z.array(TagRuleInput).max(60).default([]),
});
export type TagRulesConfigInput = z.infer<typeof TagRulesConfigInput>;

// ── Classification config (0087) — STUDIO-SEEDED-FLOWS #3+#4 ───────────────────
// The three classifier maps migrated from frozen code to per-tenant R2 config forms. The settings
// form full-replaces each table. Slack action + risk-tag vocabularies are fixed enums (the engine
// only understands these values); topics are free-form (the tenant owns the primary-topic vocabulary).
export const SLACK_TRIAGE_ACTIONS = ["close", "reopen", "snooze", "assign_me", "unassign"] as const;
export const RISK_TAGS = [
  "refund_dispute", "cancellation", "escalation", "legal", "security", "negative_sentiment", "payment_pii",
] as const;

export const TopicRuleInput = z.object({
  topic: z.string().min(1).max(40),
  keywords: z.array(z.string().min(1).max(80)).max(60).default([]),
  enabled: z.boolean().default(true),
});
export type TopicRuleInput = z.infer<typeof TopicRuleInput>;

export const ReactionEntryInput = z.object({
  emoji: z.string().min(1).max(80),
  action: z.enum(SLACK_TRIAGE_ACTIONS),
});
export type ReactionEntryInput = z.infer<typeof ReactionEntryInput>;

export const RiskKeywordInput = z.object({
  riskTag: z.enum(RISK_TAGS),
  keywords: z.array(z.string().min(1).max(80)).max(50).default([]),
  enabled: z.boolean().default(true),
});
export type RiskKeywordInput = z.infer<typeof RiskKeywordInput>;

export const ClassificationConfigInput = z.object({
  topicRules: z.array(TopicRuleInput).max(60).default([]),
  reactionMap: z.array(ReactionEntryInput).max(60).default([]),
  riskKeywords: z.array(RiskKeywordInput).max(60).default([]),
});
export type ClassificationConfigInput = z.infer<typeof ClassificationConfigInput>;

// ── Discord ops-mirror (forum mirror) config ─────────────────────────────────
export const MirrorFilterInput = z.object({
  priorities: z.array(z.string().max(20)).max(10).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  topics: z.array(z.string().max(60)).max(20).optional(),
  teamIds: z.array(z.string().uuid()).max(20).optional(),
  channels: z.array(z.string().max(30)).max(10).optional(),
});
export type MirrorFilterInput = z.infer<typeof MirrorFilterInput>;

export const DiscordMirrorBindingInput = z.object({
  guildId: z.string().min(1).max(30),
  forumChannelId: z.string().min(1).max(30),
  enabled: z.boolean().default(true),
  responderRoleId: z.string().max(30).nullable().optional(),
  attributionMode: z.enum(["team", "collaborator"]).default("team"),
  attributionName: z.string().max(80).nullable().optional(),
  filter: MirrorFilterInput.default({}),
});
export type DiscordMirrorBindingInput = z.infer<typeof DiscordMirrorBindingInput>;

export const DiscordMirrorConfigInput = z.object({
  bindings: z.array(DiscordMirrorBindingInput).max(20).default([]),
});
export type DiscordMirrorConfigInput = z.infer<typeof DiscordMirrorConfigInput>;

// ── Discord customer channels (VIP, D5) ──────────────────────────────────────
export const DiscordChannelBindingInput = z.object({
  guildId: z.string().min(1).max(30),
  channelId: z.string().min(1).max(30),
  // "forum": community-forum intake — every post = its own ticket (author = customer, the post
  // thread = the conversation). "text": classic channel binding (threads / VIP per-message).
  kind: z.enum(["text", "forum"]).default("text"),
  mode: z.enum(["staffed", "community", "off"]).default("staffed"),
  requireThread: z.boolean().default(true),
  threadPerMessage: z.boolean().default(false),
  companyId: z.string().uuid().nullable().optional(),
  // Per-binding AI override (beats the channel-type mode): null = inherit workspace policy.
  autoreplyMode: z.enum(["off", "suggest", "auto"]).nullable().optional(),
});
export type DiscordChannelBindingInput = z.infer<typeof DiscordChannelBindingInput>;

export const DiscordChannelsConfigInput = z.object({
  bindings: z.array(DiscordChannelBindingInput).max(100).default([]),
});
export type DiscordChannelsConfigInput = z.infer<typeof DiscordChannelsConfigInput>;

// ── Flows: the executable-DAG model (Lane 1) ─────────────────────────────────
/** A typed node in an automation's graph. `config` holds the type-specific payload: trigger →
 *  {} (entry), branch → {conditions: AutomationConditions}, action → {action: AutomationAction}.
 *  When an automation has a `graph`, the engine walks it (topological order, branch true/false
 *  routing, data-passing via {{steps.<id>.<field>}}); a null graph runs the linear `actions`. */
export const FLOW_NODE_TYPES = ["trigger", "branch", "action", "agent", "item"] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

// ── Studio-fold item nodes ──────────────────────────────────────────────────────
// The `item` node type carries a studio-style general-purpose node whose specific kind lives in
// `config.kind` (config stays an opaque record, so item params need no contract change). These
// run on the shared {json,text} item data-plane threaded along graph edges.
export const FLOW_ITEM_KINDS = [
  "httpRequest", "setVar", "code", "setFields", "filter", "merge", "aggregate", "ifCond",
  "openUrl", "navBack", "navForward", "reload", "waitFor",
  "clickSelector", "typeText", "selectOption", "hover", "scroll", "pressKey", "getText", "screenshot",
  "act", "observe", "extract", "agent",
] as const;
export type FlowItemKind = (typeof FLOW_ITEM_KINDS)[number];
// Kinds that require a real browser (Playwright/Stagehand) — they run in the flow-runner container,
// not in the api process (see the Studio→Studio fold, §4).
export const FLOW_BROWSER_KINDS = new Set<FlowItemKind>([
  "openUrl", "navBack", "navForward", "reload", "waitFor", "clickSelector", "typeText", "selectOption",
  "hover", "scroll", "pressKey", "getText", "screenshot", "act", "observe", "extract", "agent",
]);

export const FlowNodeSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(FLOW_NODE_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

/** A directed edge. `when` labels a branch node's true/false output; an unlabeled edge from a
 *  non-branch node is always taken. */
export const FlowEdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  when: z.enum(["true", "false"]).optional(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowGraphSchema = z.object({
  nodes: z.array(FlowNodeSchema).max(100),
  edges: z.array(FlowEdgeSchema).max(200),
});
export type FlowGraph = z.infer<typeof FlowGraphSchema>;

export const AutomationInput = z.object({
  name: z.string().min(1).max(120),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  enabled: z.boolean().optional(),
  // Per-trigger config (schedule interval today). Nullable/optional; other triggers ignore it.
  triggerConfig: AutomationTriggerConfigSchema.optional(),
  conditions: AutomationConditionsSchema.default({ match: "all", conditions: [] }),
  // Linear actions (the classic path). A graph-based automation may leave this empty.
  actions: z.array(AutomationActionSchema).max(10).default([]),
  // The executable DAG. When present it supersedes `actions`.
  graph: FlowGraphSchema.nullable().optional(),
});
export type AutomationInput = z.infer<typeof AutomationInput>;

/** PATCH /automations/:id — partial. */
export const AutomationUpdateInput = AutomationInput.partial();
export type AutomationUpdateInput = z.infer<typeof AutomationUpdateInput>;

/** Dry-run a rule against a sample context (POST /automations/:id/test) — evaluates the
 *  conditions and returns the plan WITHOUT executing any action. */
export const AutomationTestInput = z.object({
  context: z.record(z.string(), z.unknown()).default({}),
});
export type AutomationTestInput = z.infer<typeof AutomationTestInput>;

/** POST /automations/author — natural-language flow authoring (dogfood L3-E2). The model returns a
 *  DISABLED draft automation the user reviews on the canvas, dry-runs, then arms. */
export const AutomationAuthorInput = z.object({
  prompt: z.string().min(1).max(2000),
});

/** POST /tickets/:id/merge — fold this ticket (the duplicate) into `into` (the canonical ticket).
 *  The duplicate's messages move to the canonical and the duplicate is closed + flagged. */
export const MergeTicketInput = z.object({
  into: z.guid(),
});
export type MergeTicketInput = z.infer<typeof MergeTicketInput>;

/** POST /tickets/:id/snooze — park the ticket until `until` (ISO), or unsnooze with null. */
export const SnoozeTicketInput = z.object({
  until: z.string().datetime().nullable(),
});
export type SnoozeTicketInput = z.infer<typeof SnoozeTicketInput>;

/** POST /contacts/:id/merge — fold the `dropId` contact into this one (identity resolution). The
 *  path id is kept; `dropId` is merged in and deleted. */
export const ContactMergeInput = z.object({
  dropId: z.guid(),
});
export type ContactMergeInput = z.infer<typeof ContactMergeInput>;

/** POST /tickets/:id/links — link this ticket to `linkedId` (symmetric, non-destructive). */
export const LinkTicketInput = z.object({
  linkedId: z.guid(),
  relation: z.string().max(40).optional(),
});
export type LinkTicketInput = z.infer<typeof LinkTicketInput>;

/** PATCH /knowledge-gaps/:id — triage a content gap: resolve (optionally linking the KB article
 *  that closed it), dismiss (ignore), or reopen. */
export const KnowledgeGapUpdateInput = z.object({
  status: z.enum(["open", "resolved", "dismissed"]).optional(),
  resolvedArticleId: z.guid().nullable().optional(),
});
export type KnowledgeGapUpdateInput = z.infer<typeof KnowledgeGapUpdateInput>;
export type AutomationAuthorInput = z.infer<typeof AutomationAuthorInput>;

// ── Wave 4: conversational reach (multilingual + channel registry) ───────────

/** PUT /settings/translation — the workspace's own language + whether to auto-translate agent
 *  replies into the customer's detected language on send. workspaceLocale is an ISO-639-1 code. */
export const TranslationSettingsInput = z.object({
  workspaceLocale: z.string().trim().min(2).max(8),
  autoTranslate: z.boolean(),
});
export type TranslationSettingsInput = z.infer<typeof TranslationSettingsInput>;

// ── Wave 5: custom data events ───────────────────────────────────────────────

/** POST /contacts/:id/events — record a named activity event (authed, contact known by id). */
export const ContactEventInput = z.object({
  name: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ContactEventInput = z.infer<typeof ContactEventInput>;

/** POST /public/events — track an event by contact identity (api-key lane, upserts the contact). */
export const PublicEventInput = z.object({
  externalId: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(320).optional(),
  name: z.string().trim().min(1).max(120),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PublicEventInput = z.infer<typeof PublicEventInput>;
