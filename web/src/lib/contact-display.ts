import type { Contact } from "@/lib/contacts";

// Contact display helpers — the ONE place name resolution + attribute classification live, so the
// list, the detail header, avatars, dialogs, and the facts rail all speak the same language.
//
// NB: the web can't import @repo/contracts (separate build), so the system-key set is mirrored here.
// Keep in sync with SYSTEM_ATTRIBUTE_KEYS in packages/contracts/src/index.ts.

/** System-derived signals Noola computes per visit — grouped + shown READ-ONLY on the profile,
 *  never as editable custom attributes. Matched case-insensitively. */
export const SYSTEM_ATTRIBUTE_GROUPS: Record<string, string> = {
  City: "Location",
  Region: "Location",
  Country: "Location",
  "Continent code": "Location",
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
