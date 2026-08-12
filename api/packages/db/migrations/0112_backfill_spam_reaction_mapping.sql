-- Backfill the 🚫 (no_entry_sign) -> spam reaction-triage mapping for tenants that were seeded
-- before it became a built-in default.
--
-- ensureClassificationDefaults() seeds slack_reaction_map ONCE per tenant, guarded by the
-- classification_settings marker, and never re-runs. `no_entry_sign -> spam` was added to
-- DEFAULT_REACTION_MAP after existing tenants had already been seeded, so it never reached them.
-- Symptom: the Discord ops-mirror footer advertises "🚫 marks spam", but the reaction resolves to
-- an empty map entry -> applyMirrorTriage returns `unmapped_emoji` and the gateway silently drops
-- it, while the web Mark-as-spam route (which never consults the map) works. This backfills the row
-- so the reaction path reaches markConversationSpam like every other triage emoji.
--
-- Runs as the migration superuser, so the cross-tenant SELECT/INSERT bypasses RLS. Idempotent:
-- ON CONFLICT DO NOTHING leaves any existing or customized (tenant_id, emoji) row untouched. New
-- tenants are unaffected — they already seed the current default set, which includes this row.
INSERT INTO slack_reaction_map (tenant_id, emoji, action)
SELECT cs.tenant_id, 'no_entry_sign', 'spam'
  FROM classification_settings cs
ON CONFLICT (tenant_id, emoji) DO NOTHING;
