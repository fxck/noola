import type { FastifyBaseLogger } from "fastify";
import { relayPool } from "@repo/db";
import { getMirrorTransport, type GuildSnapshot, type MirrorTransport } from "./discord-gateway.js";

// Our own cache of each Discord guild's Settings-picker lists (forums / text channels / roles),
// projected from the bot's gateway in-memory cache into discord_guild_cache. The Settings endpoints
// read from HERE, never from a live Discord fetch — so they render instantly and survive a bot/gateway
// outage (last-known lists) instead of hanging into a 504. Guild-keyed + relay-accessed (NO RLS), like
// discord_links. See migration 0111.

/** Read cached snapshots for the given guilds. Missing guilds are simply absent from the map. */
export async function getGuildSnapshots(guildIds: string[]): Promise<Map<string, GuildSnapshot>> {
  const out = new Map<string, GuildSnapshot>();
  if (guildIds.length === 0) return out;
  const r = await relayPool.query(
    "SELECT guild_id, forums, text_channels, roles FROM discord_guild_cache WHERE guild_id = ANY($1::text[])",
    [guildIds],
  );
  for (const row of r.rows as { guild_id: string; forums: unknown; text_channels: unknown; roles: unknown }[]) {
    out.set(row.guild_id, {
      // jsonb columns arrive already parsed; guard shape defensively.
      forums: Array.isArray(row.forums) ? (row.forums as GuildSnapshot["forums"]) : [],
      textChannels: Array.isArray(row.text_channels) ? (row.text_channels as GuildSnapshot["textChannels"]) : [],
      roles: Array.isArray(row.roles) ? (row.roles as GuildSnapshot["roles"]) : [],
    });
  }
  return out;
}

/** Upsert one guild's snapshot. Called by the background sync and by the on-demand cache-fill in the
 *  Settings routes (when a just-connected guild has no row yet). */
export async function upsertGuildSnapshot(guildId: string, snap: GuildSnapshot): Promise<void> {
  await relayPool.query(
    `INSERT INTO discord_guild_cache (guild_id, forums, text_channels, roles, synced_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (guild_id) DO UPDATE
       SET forums = EXCLUDED.forums, text_channels = EXCLUDED.text_channels,
           roles = EXCLUDED.roles, synced_at = now()`,
    [guildId, JSON.stringify(snap.forums), JSON.stringify(snap.textChannels), JSON.stringify(snap.roles)],
  );
}

/** The Settings read path: cached snapshots for these guilds, filling any cold miss (a just-connected
 *  guild not yet picked up by the background sync) once from the gateway in-memory cache — a synchronous
 *  read that cannot hang — and persisting it. Never issues a live Discord *fetch*, so it can't 504. */
export async function resolveGuildSnapshots(
  guildIds: string[],
  tp: MirrorTransport | null,
): Promise<Map<string, GuildSnapshot>> {
  const snaps = await getGuildSnapshots(guildIds);
  if (!tp?.snapshotGuild) return snaps;
  for (const id of guildIds) {
    if (snaps.has(id)) continue;
    const live = tp.snapshotGuild(id);
    if (live) {
      snaps.set(id, live);
      void upsertGuildSnapshot(id, live).catch(() => {}); // persist for next time; best-effort
    }
  }
  return snaps;
}

/** Background refresh: for every connected guild, snapshot the bot's gateway cache into the DB. A guild
 *  the bot can't currently see (outage / not ready) returns null and is SKIPPED — we keep its last
 *  snapshot rather than blanking it. Cheap (in-memory reads) and it can't hang. */
export async function syncDiscordGuildSnapshots(log?: FastifyBaseLogger): Promise<void> {
  const tp = getMirrorTransport();
  if (!tp?.snapshotGuild) return; // no live bot transport → nothing to project; keep existing rows
  let links;
  try {
    links = await relayPool.query("SELECT guild_id FROM discord_links");
  } catch (err) {
    log?.warn({ err }, "discord guild snapshot: link read failed");
    return;
  }
  let synced = 0;
  for (const { guild_id } of links.rows as { guild_id: string }[]) {
    const snap = tp.snapshotGuild(guild_id);
    if (!snap) continue; // bot not in guild / gateway cold — keep last-known snapshot
    try {
      await upsertGuildSnapshot(guild_id, snap);
      synced++;
    } catch (err) {
      log?.warn({ err, guildId: guild_id }, "discord guild snapshot upsert failed");
    }
  }
  if (synced) log?.debug({ synced }, "discord guild snapshots refreshed");
}
