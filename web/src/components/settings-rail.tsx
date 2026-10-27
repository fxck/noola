import { Link } from "@tanstack/react-router";
import { Brain, Sparkles, Bot, Plug, Webhook as WebhookIcon, Users, UsersRound, KeyRound, MessageSquareText, MessageCircle, MessagesSquare, Timer, ListChecks, Tags, Tag, Route, Star, ShieldCheck, ScrollText, Languages, CircleUser, LayoutTemplate, LayoutGrid, Shapes, Hash, Building2 } from "lucide-react";
import type { ComponentType } from "react";

// The shared Settings section rail — grouped (the owner's "IA overload" complaint
// applied inside Settings hardest; 18 flat rows read as noise). Channels merged
// into Integrations ("Channels & integrations"); /settings/channels redirects.
export type SettingsSection = "overview" | "profile" | "ai" | "model" | "persona" | "autoreply" | "translation" | "classification" | "routing" | "macros" | "sla" | "surveys" | "custom-fields" | "ticket-types" | "tag-rules" | "integrations" | "channels" | "messenger" | "email-templates" | "webhooks" | "discord-mirror" | "api-keys" | "sso" | "workspace" | "members" | "teams" | "audit";

export type SettingsItem = { key: SettingsSection; to: string; label: string; Icon: ComponentType<{ className?: string }> };

// Single source of truth for the settings IA — the rail AND the overview landing both read it.
export const SETTINGS_GROUPS: { label: string; items: SettingsItem[] }[] = [
  {
    label: "You",
    items: [{ key: "profile", to: "/settings/profile", label: "Profile", Icon: CircleUser }],
  },
  {
    label: "AI",
    items: [
      { key: "ai", to: "/settings/ai", label: "AI overview", Icon: Brain },
      { key: "model", to: "/settings/model", label: "AI & Model", Icon: Sparkles },
      { key: "persona", to: "/settings/persona", label: "Agent persona", Icon: MessageCircle },
      { key: "autoreply", to: "/settings/autoreply", label: "Autoreply", Icon: Bot },
      { key: "translation", to: "/settings/translation", label: "Translation", Icon: Languages },
      { key: "classification", to: "/settings/classification", label: "Classification", Icon: Shapes },
    ],
  },
  {
    label: "Conversations",
    items: [
      { key: "routing", to: "/settings/routing", label: "Routing", Icon: Route },
      { key: "macros", to: "/settings/macros", label: "Macros", Icon: MessageSquareText },
      { key: "sla", to: "/settings/sla", label: "SLA", Icon: Timer },
      { key: "surveys", to: "/settings/surveys", label: "Surveys", Icon: Star },
      { key: "custom-fields", to: "/settings/custom-fields", label: "Custom fields", Icon: ListChecks },
      { key: "ticket-types", to: "/settings/ticket-types", label: "Ticket types", Icon: Tags },
      { key: "tag-rules", to: "/settings/tag-rules", label: "Auto-tagging", Icon: Tag },
    ],
  },
  {
    label: "Channels",
    items: [
      { key: "integrations", to: "/settings/integrations", label: "Channels & integrations", Icon: Plug },
      { key: "messenger", to: "/settings/messenger", label: "Messenger", Icon: MessagesSquare },
      { key: "email-templates", to: "/settings/email-templates", label: "Email templates", Icon: LayoutTemplate },
      { key: "webhooks", to: "/settings/webhooks", label: "Webhooks", Icon: WebhookIcon },
      { key: "discord-mirror", to: "/settings/discord-mirror", label: "Discord", Icon: Hash },
    ],
  },
  {
    label: "Workspace",
    items: [
      { key: "workspace", to: "/settings/workspace", label: "Workspace", Icon: Building2 },
      { key: "members", to: "/settings/members", label: "Members", Icon: UsersRound },
      { key: "teams", to: "/settings/teams", label: "Teams", Icon: Users },
      { key: "sso", to: "/settings/sso", label: "SSO", Icon: ShieldCheck },
      { key: "api-keys", to: "/settings/api-keys", label: "API keys", Icon: KeyRound },
      { key: "audit", to: "/settings/audit", label: "Audit log", Icon: ScrollText },
    ],
  },
];

export function SettingsRail({ active }: { active: SettingsSection }) {
  // The merged Channels page lives under Integrations — both keys highlight it.
  const activeKey = active === "channels" ? "integrations" : active;
  return (
    <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r px-3 py-3 md:flex">
      <div className="flex h-9 items-center px-2">
        <h2 className="text-sm font-semibold tracking-tight">Settings</h2>
      </div>
      {/* Overview lands above the groups — the settings home. */}
      {activeKey === "overview" ? (
        <span
          aria-current="page"
          className="mt-1 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-small font-medium text-foreground"
        >
          <LayoutGrid className="size-4 text-primary" /> Overview
        </span>
      ) : (
        <Link
          to="/settings"
          className="mt-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-small font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <LayoutGrid className="size-4" /> Overview
        </Link>
      )}
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.label} className="pt-3 first:pt-1">
          <p className="px-2 pb-1 text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">
            {g.label}
          </p>
          {g.items.map(({ key, to, label, Icon }) =>
            key === activeKey ? (
              <span
                key={key}
                aria-current="page"
                className="flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-small font-medium text-foreground"
              >
                <Icon className="size-4 text-primary" /> {label}
              </span>
            ) : (
              <Link
                key={key}
                to={to}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-small font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Icon className="size-4" /> {label}
              </Link>
            ),
          )}
        </div>
      ))}
    </aside>
  );
}
