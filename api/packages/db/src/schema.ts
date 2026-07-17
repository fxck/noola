import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  jsonb,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";

// Typed source of truth for queries. DDL/RLS/roles live in migrations/0000_init.sql
// (drizzle-kit doesn't express FORCE RLS + roles), so this schema mirrors it.

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.id] }) }),
);

export const tickets = pgTable(
  "tickets",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    statusCategory: text("status_category").notNull().default("open"),
    channelType: text("channel_type").notNull().default("synthetic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.id] }) }),
);

export const messages = pgTable(
  "messages",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    ticketId: uuid("ticket_id").notNull(),
    authorType: text("author_type").notNull().default("customer"),
    body: text("body").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.id] }),
    ticketFk: foreignKey({
      columns: [t.tenantId, t.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
    }).onDelete("cascade"),
  }),
);

export const outbox = pgTable("outbox", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id").notNull(),
  eventType: text("event_type").notNull(),
  subject: text("subject").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});
