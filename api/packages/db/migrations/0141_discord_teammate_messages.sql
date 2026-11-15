-- Discord messages and mirror notes that teammates wrote before they linked their Discord id have no Noola seat.
-- They become the teammate's, as linking does (discord-classify.ts REATTRIBUTE_SQL).
-- A re-run finds nothing left to move, so it changes nothing.
WITH moved AS (
  UPDATE messages m
     SET author_type = 'agent', author_kind = 'agent', author_id = i.user_id
    FROM tickets t, agent_channel_identities i
   WHERE t.tenant_id = m.tenant_id AND t.id = m.ticket_id AND t.channel_type = 'discord'
     AND i.tenant_id = m.tenant_id AND i.channel_type = 'discord' AND lower(i.external_id) = lower(m.author_external_id)
     AND m.author_type = 'customer'
  RETURNING m.tenant_id, m.ticket_id),
seated AS (
  UPDATE messages m
     SET author_kind = 'agent', author_id = i.user_id
    FROM tickets t, agent_channel_identities i
   WHERE t.tenant_id = m.tenant_id AND t.id = m.ticket_id AND t.channel_type = 'discord'
     AND i.tenant_id = m.tenant_id AND i.channel_type = 'discord' AND lower(i.external_id) = lower(m.author_external_id)
     AND m.author_type = 'agent' AND m.author_id IS NULL AND NOT m.auto
  RETURNING m.id),
noted AS (
  UPDATE ticket_notes n
     SET author_id = i.user_id
    FROM ticket_mirror_messages mm, agent_channel_identities i
   WHERE mm.tenant_id = n.tenant_id AND mm.note_id = n.id AND n.author_id IS NULL
     AND i.tenant_id = mm.tenant_id AND i.channel_type = 'discord' AND lower(i.external_id) = lower(mm.author_discord_id)
  RETURNING n.id),
waiting AS (
  UPDATE tickets t SET whose_turn = 'customer'
   WHERE (t.tenant_id, t.id) IN (SELECT tenant_id, ticket_id FROM moved) AND t.status = 'open'
     AND EXISTS (SELECT 1 FROM (SELECT l.author_type, l.author_external_id FROM messages l
                                  WHERE l.tenant_id = t.tenant_id AND l.ticket_id = t.id AND l.deleted_at IS NULL
                                  ORDER BY l.created_at DESC LIMIT 1) latest
                  JOIN agent_channel_identities i ON i.tenant_id = t.tenant_id AND i.channel_type = 'discord'
                   AND lower(i.external_id) = lower(latest.author_external_id)
                  WHERE latest.author_type = 'customer')
  RETURNING t.id),
unfiled AS (
  DELETE FROM knowledge_gap_questions q WHERE (q.tenant_id, q.ticket_id) IN (SELECT tenant_id, ticket_id FROM moved)
  RETURNING q.id)
DELETE FROM gap_reviews r WHERE (r.tenant_id, r.ticket_id) IN (SELECT tenant_id, ticket_id FROM moved);
