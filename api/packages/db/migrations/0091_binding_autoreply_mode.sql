-- Per-binding AI reply mode (most-specific-wins over the tenant channel_modes ceiling):
-- lets one Discord help forum auto-send while the rest of discord stays suggest/off.
-- NULL = inherit (channel_modes → global). Values: 'off' | 'suggest' | 'auto'.
ALTER TABLE discord_channel_bindings ADD COLUMN IF NOT EXISTS autoreply_mode text;
