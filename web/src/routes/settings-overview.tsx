import { Link } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings-page";
import { SETTINGS_GROUPS, type SettingsSection } from "@/components/settings-rail";

// The Settings landing — a scannable map of every settings area instead of dumping the user into
// one arbitrary page. Reads the SAME SETTINGS_GROUPS the rail does (one IA source of truth); each
// card is a quiet, one-line description in the user's terms + a link into that area.

const DESCRIPTIONS: Record<SettingsSection, string> = {
  overview: "",
  profile: "Your display name and photo.",
  ai: "How the assistant answers — grounding, safety, and coverage at a glance.",
  model: "Choose the model provider and bring your own API key.",
  persona: "The voice your AI uses in drafts and autoreplies.",
  autoreply: "How much the AI does on its own — draft, or send automatically.",
  translation: "Detect each customer's language and bridge the conversation.",
  classification: "Topics, Slack reaction shortcuts, and the safety guardrails that hold risky messages.",
  routing: "Rules that assign incoming conversations to the right people.",
  macros: "Saved replies your team can insert in one click.",
  sla: "First-response and resolution targets, with business hours.",
  surveys: "Ask customers for CSAT or NPS when a ticket resolves.",
  "custom-fields": "Your own attributes on tickets, addressable from the API.",
  "ticket-types": "A taxonomy for your tickets, separate from priority and tags.",
  "tag-rules": "Auto-tag new tickets from their text — keyword rules plus optional AI classification.",
  integrations: "Connect channels and third-party tools.",
  messenger: "Personalize the embeddable chat widget — brand, greeting, and tabs.",
  "email-templates": "The wrapper and styling for outbound email.",
  webhooks: "Send ticket and message events to your own endpoints.",
  "discord-mirror": "VIP customer channels and the forum ops mirror \u2014 tickets in and out of Discord.",
  channels: "Connect channels and third-party tools.",
  workspace: "Workspace name and logo.",
  members: "Invite teammates and manage their roles.",
  teams: "Group agents into shared inbox lanes and routing pools.",
  sso: "Single sign-on for your workspace.",
  "api-keys": "Programmatic access keys and their scopes.",
  audit: "A tamper-evident record of sensitive actions.",
};

export function SettingsOverviewPage() {
  return (
    <SettingsPage
      active="overview"
      title="Settings"
      description="Manage your workspace — AI behavior, conversation rules, channels, and team access."
    >
      <div className="max-w-4xl space-y-8 px-6 pb-12 pt-4">
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.label}>
            <h2 className="mb-2.5 text-micro font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map(({ key, to, label, Icon }) => (
                <Link
                  key={key}
                  to={to}
                  className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 shadow-sm transition-[transform,border-color,background-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium tracking-tight text-foreground">
                      {label}
                    </span>
                    <span className="mt-0.5 block text-small leading-snug text-muted-foreground">
                      {DESCRIPTIONS[key]}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SettingsPage>
  );
}
