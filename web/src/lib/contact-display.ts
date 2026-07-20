import type { Contact } from "@/lib/contacts";

// Contact display helpers — the ONE place name resolution + attribute classification live, so the
// list, the detail header, avatars, dialogs, and the facts rail all speak the same language.
//
// NB: the web can't import @repo/contracts (separate build), so the system-key set is mirrored here.
// Keep in sync with SYSTEM_ATTRIBUTE_KEYS in packages/contracts/src/index.ts.

/** Signals Noola can HONESTLY derive from a request — grouped + shown READ-ONLY on the profile,
 *  never as editable custom attributes. Matched case-insensitively. Keep in sync with
 *  SYSTEM_ATTRIBUTE_KEYS in packages/contracts. Note: "Region"/"Continent code" are intentionally
 *  absent — IP→subdivision is an unreliable guess (see contracts), so an imported `region` value
 *  correctly falls through to Custom attributes instead of masquerading as a Noola Location signal. */
export const SYSTEM_ATTRIBUTE_GROUPS: Record<string, string> = {
  City: "Location",
  Country: "Location",
  Timezone: "Location",
  Browser: "Device & browser",
  "Browser Version": "Device & browser",
  OS: "Device & browser",
  "Browser Language": "Device & browser",
  "Referral URL": "Device & browser",
  "Web sessions": "Activity",
  "Last contacted": "Activity",
  last_page_url: "Activity",
  last_page_title: "Activity",
  last_seen_at: "Activity",
};
/** The order the system groups render in. */
export const SYSTEM_GROUP_ORDER = ["Location", "Device & browser", "Activity"] as const;

const SYSTEM_LOWER = new Map(
  Object.entries(SYSTEM_ATTRIBUTE_GROUPS).map(([k, g]) => [k.toLowerCase(), g] as const),
);
/** The section a system-derived key belongs to, or null when it's a tenant custom attribute. */
export function systemAttributeGroup(key: string): string | null {
  return SYSTEM_LOWER.get(key.toLowerCase()) ?? null;
}
export function isSystemAttribute(key: string): boolean {
  return SYSTEM_LOWER.has(key.toLowerCase());
}

/** Machine-emitted plumbing that rode in on the import — SDK/router/session internals a human never
 *  set and never reads (updateOnRouterChange, appId, client_id). It shouldn't sit at the SAME visual
 *  weight as a real business attribute like `region` or `plan tier`; the detail page tucks these into
 *  a collapsed "Technical" group instead of the flat dump. Deliberately conservative — a human-authored
 *  attribute is Title Case ("Company size") or a lowercase word ("region"), so only internal-caps
 *  camelCase (updateOnRouterChange) and *_id/uuid/hash/token keys are demoted; everything else stays. */
const TECHNICAL_KEYS = new Set(
  [
    "appId", "app_id", "clientId", "client_id", "sessionId", "session_id", "deviceId", "device_id",
    "anonymousId", "anonymous_id", "installId", "install_id", "visitorId", "visitor_id",
    "updateOnRouterChange", "sdkVersion", "sdk_version", "buildNumber", "build_number", "userHash",
    "fingerprint", "utm_source", "utm_medium", "utm_campaign", "gclid", "fbclid",
  ].map((k) => k.toLowerCase()),
);
export function isTechnicalAttribute(key: string): boolean {
  const k = key.trim();
  const kl = k.toLowerCase();
  if (TECHNICAL_KEYS.has(kl)) return true;
  if (/\s/.test(k)) return false; // any human-authored label has spaces or Title Case — leave it alone
  if (/[a-z][A-Z]/.test(k)) return true; // internal-caps camelCase = machine-emitted (appId, totalStackCount)
  if (/(^|[_-])(id|uuid|guid|hash|token|key)$/i.test(kl)) return true; // opaque identifiers
  return false;
}

/** Look up an attribute value case-insensitively across a few candidate keys. */
function attrValue(attrs: Record<string, string> | undefined, ...keys: string[]): string {
  if (!attrs) return "";
  const lower = new Map(Object.keys(attrs).map((k) => [k.toLowerCase(), k] as const));
  for (const want of keys) {
    const hit = lower.get(want.toLowerCase());
    if (hit && attrs[hit]?.trim()) return attrs[hit].trim();
  }
  return "";
}

/** A real human name composed from First/Last name attributes, or "" if absent. */
export function composedName(c: Pick<Contact, "attributes">): string {
  return [attrValue(c.attributes, "First name"), attrValue(c.attributes, "Last name")]
    .filter(Boolean)
    .join(" ");
}

const CHANNEL_VISITOR: Record<string, string> = {
  widget: "Widget visitor",
  email: "Email contact",
  discord: "Discord user",
  slack: "Slack user",
  telegram: "Telegram user",
  whatsapp: "WhatsApp user",
};

/** A channel-aware label for a contact with no recognizable name/email (a widget visitor, an
 *  unidentified Discord poster, …) — never a bare "Unnamed". */
export function anonymousLabel(c: Contact): string {
  const base = CHANNEL_VISITOR[c.primary_channel ?? ""] ?? "Anonymous";
  return `${base} · ${c.id.slice(0, 4)}`;
}

/** The resolved display name: real name → composed First/Last → email → channel-aware anonymous.
 *  So an imported human name stranded in attributes no longer renders as blank, and a handle-only
 *  contact reads as "Discord user" rather than a raw id. */
export function contactDisplayName(c: Contact): string {
  return c.name?.trim() || composedName(c) || c.email?.trim() || anonymousLabel(c);
}

const CHANNEL_LABEL: Record<string, string> = {
  widget: "Web widget",
  email: "Email",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};
/** A human channel name for an identity row ("Discord" not "discord"). */
export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}
