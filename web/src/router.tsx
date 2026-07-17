import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import type { AuthState } from "@/auth/auth";
import { RootShell } from "@/components/root-shell";
import { LoginPage } from "@/routes/login";
import { ForgotPasswordPage } from "@/routes/forgot-password";
import { ResetPasswordPage } from "@/routes/reset-password";
import { SignupPage } from "@/routes/signup";
import { InvitePage } from "@/routes/invite";
import { JoinPage } from "@/routes/join";
import { SsoCallbackPage } from "@/routes/sso-callback";
import { SettingsMembersPage } from "@/routes/settings-members";
import { SettingsWorkspacePage } from "@/routes/settings-workspace";
import { InboxPage } from "@/routes/inbox";
import { TicketsPage } from "@/routes/tickets";
import { ConversationPage } from "@/routes/conversation";
import { AnalyticsPage } from "@/routes/analytics";
import { KbPage } from "@/routes/kb";
import { SourcesPage } from "@/routes/sources";
import { ContactsPage } from "@/routes/contacts-list";
import { ContactDetailPage } from "@/routes/contact-detail";
import { KbArticlePage, KbNewPage, KbEditPage } from "@/routes/kb-detail";
import { SourceDetailPage } from "@/routes/source-detail";
import { DocumentDetailPage } from "@/routes/document-detail";
import { BroadcastsPage } from "@/routes/broadcasts";
import { BroadcastDetailPage } from "@/routes/broadcast-detail";
import { SettingsOverviewPage } from "@/routes/settings-overview";
import { SettingsProfilePage } from "@/routes/settings-profile";
import { SettingsModelPage } from "@/routes/settings-model";
import { SettingsAiPage } from "@/routes/settings-ai";
import { SettingsAutoreplyPage } from "@/routes/settings-autoreply";
import { SettingsTranslationPage } from "@/routes/settings-translation";
import { SettingsTagRulesPage } from "@/routes/settings-tag-rules";
import { SettingsClassificationPage } from "@/routes/settings-classification";
import { SettingsDiscordMirrorPage } from "@/routes/settings-discord-mirror";
import { SettingsWebhooksPage } from "@/routes/settings-webhooks";
import { SettingsApiKeysPage } from "@/routes/settings-api-keys";
import { SettingsMessengerPage } from "@/routes/settings-messenger";
import { SettingsMacrosPage } from "@/routes/settings-macros";
import { SettingsSlaPage } from "@/routes/settings-sla";
import { SettingsRoutingPage } from "@/routes/settings-routing";
import { SettingsTeamsPage } from "@/routes/settings-teams";
import { SettingsSurveysPage } from "@/routes/settings-surveys";
import { SettingsSsoPage } from "@/routes/settings-sso";
import { SettingsAuditPage } from "@/routes/settings-audit";
import { HelpCenterPage, HelpArticlePage } from "@/routes/help";
import { CompaniesPage, CompanyDetailPage } from "@/routes/companies";
import { FeaturesPage } from "@/routes/features";
import { SettingsPersonaPage } from "@/routes/settings-persona";
import { SettingsCustomFieldsPage } from "@/routes/settings-custom-fields";
import { SettingsTicketTypesPage } from "@/routes/settings-ticket-types";
import { SettingsIntegrationsPage } from "@/routes/settings-integrations";
import { SettingsEmailTemplatesPage } from "@/routes/settings-email-templates";
import { AgentStudioPage } from "@/routes/studio";

interface RouterContext {
  auth: AuthState;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootShell,
});

// Public help center — unauthenticated, widget-key scoped (?key=…). No auth guard.
const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help",
  validateSearch: (s: Record<string, unknown>): { key?: string; collection?: string } => ({
    key: typeof s.key === "string" ? s.key : undefined,
    collection: typeof s.collection === "string" ? s.collection : undefined,
  }),
  component: HelpCenterPage,
});

const helpArticleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help/$slug",
  validateSearch: (s: Record<string, unknown>): { key?: string } => ({
    key: typeof s.key === "string" ? s.key : undefined,
  }),
  component: HelpArticlePage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: ({ context }) => {
    if (context.auth.isAuthed) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forgot-password",
  component: ForgotPasswordPage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: ResetPasswordPage,
});

// Self-serve sign-up (create an account + first workspace). Like /login, bounce to the app if
// already signed in.
const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  beforeLoad: ({ context }) => {
    if (context.auth.isAuthed) throw redirect({ to: "/" });
  },
  component: SignupPage,
});

// Public invite/join landing + accept. NOT auth-gated — the invitee/joiner has no session yet;
// the page authenticates (or creates) the account server-side on accept/join.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$id",
  component: InvitePage,
});

const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  component: JoinPage,
});

// Enterprise SSO landing — the IdP handoff completes here (token in the URL fragment). NOT
// auth-gated: the arriving user has no session in the SPA yet; this route is what establishes it.
const ssoCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sso/callback",
  component: SsoCallbackPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // Optional deep-links: `/?ticket=<id>` preselects a thread; `/?view=approval`
  // opens a specific inbox view (the old /queue redirects here).
  validateSearch: (search: Record<string, unknown>): { ticket?: string; view?: string } => ({
    ticket: typeof search.ticket === "string" ? search.ticket : undefined,
    view: typeof search.view === "string" ? search.view : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: InboxPage,
});

interface TicketsSearch {
  status?: "open" | "closed" | "all";
  priority?: string; // csv of priorities
  team?: string; // team id, or "none" = no team
  assignee?: string; // user id, or "none" = unassigned
  q?: string;
  sort?: "updated_at" | "created_at" | "priority" | "sla";
  sortDir?: "asc" | "desc";
  page?: number;
}

const ticketsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tickets",
  // Deep-linkable, shareable filtered views — the table mirrors its state into the URL.
  validateSearch: (search: Record<string, unknown>): TicketsSearch => ({
    status: search.status === "closed" || search.status === "all" ? search.status : search.status === "open" ? "open" : undefined,
    priority: typeof search.priority === "string" ? search.priority : undefined,
    team: typeof search.team === "string" ? search.team : undefined,
    assignee: typeof search.assignee === "string" ? search.assignee : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    sort: search.sort === "created_at" || search.sort === "priority" || search.sort === "sla" ? search.sort : search.sort === "updated_at" ? "updated_at" : undefined,
    sortDir: search.sortDir === "asc" ? "asc" : search.sortDir === "desc" ? "desc" : undefined,
    page: typeof search.page === "number" ? search.page : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: TicketsPage,
});

// The table row opens this focused conversation — the SAME ThreadPane the inbox
// uses, list hidden + Back button. URL-tracked by id; there is no second detail.
const ticketDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tickets/$ticketId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: ConversationPage,
});

const kbRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kb",
  // ?collection=<id> scopes the KB list to a collection (deep-linkable); "none" =
  // uncategorized; absent = all (grouped by collection in the UI).
  // ?article=<id> restores the previewed article (row selection is shareable).
  validateSearch: (search: Record<string, unknown>): { collection?: string; article?: string } => ({
    collection: typeof search.collection === "string" ? search.collection : undefined,
    article: typeof search.article === "string" ? search.article : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: KbPage,
});

const kbNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kb/new",
  // Carries the active collection so a new article defaults into it, and —
  // when seeded from a knowledge gap — the gap's question (title prefill) +
  // gap id (auto-resolved once the article saves).
  validateSearch: (
    search: Record<string, unknown>,
  ): { collection?: string; title?: string; gap?: string } => ({
    collection: typeof search.collection === "string" ? search.collection : undefined,
    title: typeof search.title === "string" ? search.title : undefined,
    gap: typeof search.gap === "string" ? search.gap : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: KbNewPage,
});

const kbArticleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kb/$articleId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: KbArticlePage,
});

const kbEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/kb/$articleId/edit",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: KbEditPage,
});

const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SourcesPage,
});

const sourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources/$sourceId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SourceDetailPage,
});

// Deep-linkable viewer for an uploaded document's raw text (CodeMirror). Reached from the
// Sources → Uploads list; documents live under the Sources nav.
const documentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/documents/$id",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: DocumentDetailPage,
});

interface ContactsSearch {
  q?: string;
  filters?: string;
  filterGroups?: string;
  sort?: string;
  page?: number;
  /** Opens the New-contact editor on arrival (⌘K "New contact" deep-links here). Self-clearing. */
  create?: boolean;
}

const contactsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts",
  // Deep-linkable, shareable filtered views: the table mirrors its state here. `filters` is
  // the JSON-encoded rich condition list (field/op/value); `filterGroups` the OR-grouped
  // form (an array of condition lists) once the view has 2+ rows; q/sort/page are the rest.
  validateSearch: (search: Record<string, unknown>): ContactsSearch => ({
    q: typeof search.q === "string" ? search.q : undefined,
    filters: typeof search.filters === "string" ? search.filters : undefined,
    filterGroups: typeof search.filterGroups === "string" ? search.filterGroups : undefined,
    sort: typeof search.sort === "string" ? search.sort : undefined,
    page: typeof search.page === "number" ? search.page : undefined,
    create: search.create === true ? true : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: ContactsPage,
});

const contactDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/contacts/$contactId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: ContactDetailPage,
});

const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: CompaniesPage,
});

const companyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies/$companyId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: CompanyDetailPage,
});

const featuresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/features",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: FeaturesPage,
});

const broadcastsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/broadcasts",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  // ?edit=<draft id> — the detail page's Edit hands off to the list surface,
  // which opens the composer seeded from that draft (drafts only).
  validateSearch: (search: Record<string, unknown>): { edit?: string } => ({
    edit: typeof search.edit === "string" ? search.edit : undefined,
  }),
  component: BroadcastsPage,
});

const broadcastDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/broadcasts/$broadcastId",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: BroadcastDetailPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  // ?view selects the Insight section (overview when absent | topics | quality | workload | sla).
  validateSearch: (search: Record<string, unknown>): { view?: "ops" | "containment" | "topics" | "quality" | "workload" | "sla" | "csat" | "reports" } => ({
    view:
      search.view === "ops" || search.view === "containment" || search.view === "topics" || search.view === "quality" || search.view === "workload" || search.view === "sla" || search.view === "csat" || search.view === "reports"
        ? search.view
        : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: AnalyticsPage,
});

// Old standalone Insight/testing surfaces — folded into the Analytics hub and
// Studio's Test bench. Redirects keep deep links alive.
const topicsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topics",
  beforeLoad: () => {
    throw redirect({ to: "/analytics", search: { view: "topics" } });
  },
});

const qaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/qa",
  beforeLoad: () => {
    throw redirect({ to: "/analytics", search: { view: "quality" } });
  },
});

const simulationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/simulations",
  beforeLoad: () => {
    throw redirect({ to: "/studio", search: { view: "test" } });
  },
});

// The old Queue surface dissolved: approvals live in the Inbox ("Needs approval"
// view + the in-thread approval panel); the autopilot board lives in Studio.
const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  beforeLoad: () => {
    throw redirect({ to: "/", search: { view: "approval" } });
  },
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsOverviewPage,
});

const settingsProfileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/profile",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsProfilePage,
});

const settingsModelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/model",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsModelPage,
});

const settingsAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/ai",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsAiPage,
});

const settingsAutoreplyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/autoreply",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsAutoreplyPage,
});

const settingsTranslationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/translation",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsTranslationPage,
});

const settingsTagRulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/tag-rules",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsTagRulesPage,
});

const settingsClassificationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/classification",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsClassificationPage,
});

const settingsDiscordMirrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/discord-mirror",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsDiscordMirrorPage,
});

// Channels merged into Integrations ("Channels & integrations") — the redirect keeps
// old deep links alive.
const settingsChannelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/channels",
  beforeLoad: () => {
    throw redirect({ to: "/settings/integrations" });
  },
});

const settingsWebhooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/webhooks",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsWebhooksPage,
});

const settingsApiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/api-keys",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsApiKeysPage,
});

const settingsMessengerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/messenger",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsMessengerPage,
});

const settingsMacrosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/macros",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsMacrosPage,
});

const settingsSlaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/sla",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsSlaPage,
});

const settingsRoutingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/routing",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsRoutingPage,
});

const settingsTeamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/teams",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsTeamsPage,
});

const settingsSurveysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/surveys",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsSurveysPage,
});

const settingsSsoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/sso",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsSsoPage,
});

const settingsAuditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/audit",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsAuditPage,
});

const settingsPersonaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/persona",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsPersonaPage,
});

const settingsCustomFieldsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/custom-fields",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsCustomFieldsPage,
});

const settingsTicketTypesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/ticket-types",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsTicketTypesPage,
});

const settingsMembersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/members",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsMembersPage,
});

const settingsWorkspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/workspace",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsWorkspacePage,
});

// Agent Studio — the top-level visual builder surface (canvas-first). Automations were
// promoted out of Settings into their own primary destination.
const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  // ?id opens a flow, ?new seeds one, ?view=test shows the Test bench (agent
  // simulation — dry-runs of the AI live beside the flows they exercise).
  validateSearch: (search: Record<string, unknown>): { id?: string; new?: string; view?: string } => ({
    id: typeof search.id === "string" ? search.id : undefined,
    new: typeof search.new === "string" ? search.new : undefined,
    view: typeof search.view === "string" ? search.view : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: AgentStudioPage,
});

// The old Settings entry now redirects to the primary Studio surface (keeps deep links alive).
const settingsAutomationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/automations",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
    throw redirect({ to: "/studio" });
  },
  component: AgentStudioPage,
});

const settingsIntegrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/integrations",
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsIntegrationsPage,
});

// Email template designer — ?template=<id> deep-links straight into a template's
// designer view (absent = the list).
const settingsEmailTemplatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/email-templates",
  validateSearch: (search: Record<string, unknown>): { template?: string } => ({
    template: typeof search.template === "string" ? search.template : undefined,
  }),
  beforeLoad: ({ context }) => {
    if (!context.auth.isAuthed) throw redirect({ to: "/login" });
  },
  component: SettingsEmailTemplatesPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  inviteRoute,
  joinRoute,
  ssoCallbackRoute,
  inboxRoute,
  ticketsRoute,
  ticketDetailRoute,
  kbRoute,
  kbNewRoute,
  kbArticleRoute,
  kbEditRoute,
  sourcesRoute,
  sourceDetailRoute,
  documentDetailRoute,
  contactsRoute,
  contactDetailRoute,
  companiesRoute,
  companyDetailRoute,
  featuresRoute,
  broadcastsRoute,
  broadcastDetailRoute,
  topicsRoute,
  qaRoute,
  simulationsRoute,
  analyticsRoute,
  queueRoute,
  studioRoute,
  settingsIndexRoute,
  settingsProfileRoute,
  settingsModelRoute,
  settingsPersonaRoute,
  settingsAiRoute,
  settingsAutoreplyRoute,
  settingsTranslationRoute,
  settingsTagRulesRoute,
  settingsClassificationRoute,
  settingsDiscordMirrorRoute,
  settingsChannelsRoute,
  settingsWebhooksRoute,
  settingsApiKeysRoute,
  settingsMessengerRoute,
  settingsMacrosRoute,
  settingsSlaRoute,
  settingsRoutingRoute,
  settingsTeamsRoute,
  settingsSurveysRoute,
  settingsSsoRoute,
  settingsAuditRoute,
  helpRoute,
  helpArticleRoute,
  settingsCustomFieldsRoute,
  settingsTicketTypesRoute,
  settingsMembersRoute,
  settingsWorkspaceRoute,
  settingsAutomationsRoute,
  settingsIntegrationsRoute,
  settingsEmailTemplatesRoute,
]);

export const router = createRouter({
  routeTree,
  context: { auth: undefined! },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
