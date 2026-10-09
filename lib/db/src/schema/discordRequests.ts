import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const discordRequestsTable = pgTable(
  "discord_requests",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    memberId: text("member_id").notNull(),
    memberTag: text("member_tag").notNull(),
    description: text("description").notNull().default(""),
    setupDetails: text("setup_details").notNull().default(""),
    status: text("status").notNull().default("awaiting_member"),
    stage: text("stage").notNull().default("request"),
    assignedToId: text("assigned_to_id"),
    requestChannelId: text("request_channel_id"),
    requestMessageId: text("request_message_id"),
    threadId: text("thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("discord_requests_guild_member_status_idx").on(
      table.guildId,
      table.memberId,
      table.status,
    ),
    index("discord_requests_guild_created_idx").on(table.guildId, table.createdAt),
    index("discord_requests_expiration_idx").on(table.status, table.lastActivityAt),
  ],
);

export const discordRequestFollowupsTable = pgTable(
  "discord_request_followups",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .notNull()
      .references(() => discordRequestsTable.id, { onDelete: "cascade" }),
    askedById: text("asked_by_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull().default(""),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (table) => [
    index("discord_request_followups_pending_idx").on(table.requestId, table.status),
  ],
);

export const discordRequestAttachmentsTable = pgTable(
  "discord_request_attachments",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .notNull()
      .references(() => discordRequestsTable.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    threadMessageId: text("thread_message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("discord_request_attachments_request_idx").on(table.requestId),
  ],
);

export const discordRequestEventsTable = pgTable(
  "discord_request_events",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").references(() => discordRequestsTable.id, {
      onDelete: "cascade",
    }),
    guildId: text("guild_id").notNull(),
    actorId: text("actor_id").notNull(),
    eventType: text("event_type").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("discord_request_events_request_idx").on(table.requestId, table.createdAt),
    index("discord_request_events_guild_idx").on(table.guildId, table.createdAt),
  ],
);

export const discordCommandPermissionsTable = pgTable(
  "discord_command_permissions",
  {
    guildId: text("guild_id").notNull(),
    commandName: text("command_name").notNull(),
    userId: text("user_id").notNull(),
    effect: text("effect").notNull().default("allow"),
    grantedById: text("granted_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "discord_command_permissions_pk",
      columns: [table.guildId, table.commandName, table.userId],
    }),
    index("discord_command_permissions_user_idx").on(table.guildId, table.userId),
  ],
);

export const discordOwnerAccessTable = pgTable(
  "discord_owner_access",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    grantedById: text("granted_by_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "discord_owner_access_pk",
      columns: [table.guildId, table.userId],
    }),
  ],
);

export const discordBotSettingsTable = pgTable("discord_bot_settings", {
  guildId: text("guild_id").primaryKey(),
  logChannelId: text("log_channel_id"),
  retentionDays: integer("retention_days"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDiscordRequestSchema = createInsertSchema(discordRequestsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  reminderSentAt: true,
  closedAt: true,
});
export type InsertDiscordRequest = z.infer<typeof insertDiscordRequestSchema>;
export type DiscordRequest = typeof discordRequestsTable.$inferSelect;

export const insertDiscordRequestFollowupSchema = createInsertSchema(
  discordRequestFollowupsTable,
).omit({ id: true, createdAt: true, answeredAt: true });
export type InsertDiscordRequestFollowup = z.infer<
  typeof insertDiscordRequestFollowupSchema
>;
export type DiscordRequestFollowup =
  typeof discordRequestFollowupsTable.$inferSelect;

export type DiscordRequestAttachment =
  typeof discordRequestAttachmentsTable.$inferSelect;
export type DiscordRequestEvent = typeof discordRequestEventsTable.$inferSelect;
export type DiscordCommandPermission =
  typeof discordCommandPermissionsTable.$inferSelect;
