import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import {
  db,
  discordBotSettingsTable,
  discordCommandPermissionsTable,
  discordRequestAttachmentsTable,
  discordRequestEventsTable,
  discordRequestFollowupsTable,
  discordRequestsTable,
  type DiscordRequest,
} from "@workspace/db";

const TERMINAL_STATUSES = ["completed", "declined", "cancelled", "expired"];

export type RequestStatus =
  | "awaiting_member"
  | "waiting_on_member"
  | "received"
  | "needs_info"
  | "accepted"
  | "in_progress"
  | "completed"
  | "declined"
  | "cancelled"
  | "expired";

export type RequestStage = "request" | "setup" | "complete" | "followup";

export interface RequestFilters {
  status?: RequestStatus;
  memberId?: string;
  page?: number;
  pageSize?: number;
}

export async function verifyStoreReady(): Promise<void> {
  await db.select({ id: discordRequestsTable.id }).from(discordRequestsTable).limit(1);
}

export async function createRequest(input: {
  guildId: string;
  memberId: string;
  memberTag: string;
}): Promise<DiscordRequest> {
  const now = new Date();
  const [request] = await db
    .insert(discordRequestsTable)
    .values({
      ...input,
      status: "awaiting_member",
      stage: "request",
      lastActivityAt: now,
    })
    .returning();
  if (!request) throw new Error("Request insert returned no row.");

  await recordRequestEvent({
    requestId: request.id,
    guildId: input.guildId,
    actorId: input.memberId,
    eventType: "request_started",
  });
  return request;
}

export async function findActiveRequestForMember(
  guildId: string,
  memberId: string,
): Promise<DiscordRequest | null> {
  const [request] = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        notInArray(discordRequestsTable.status, TERMINAL_STATUSES),
      ),
    )
    .orderBy(desc(discordRequestsTable.id))
    .limit(1);
  return request ?? null;
}

export async function findPendingMemberFlowForMember(
  guildId: string,
  memberId: string,
): Promise<DiscordRequest | null> {
  const [request] = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        inArray(discordRequestsTable.status, ["awaiting_member", "waiting_on_member"]),
      ),
    )
    .orderBy(desc(discordRequestsTable.id))
    .limit(1);
  return request ?? null;
}

export async function findRequestById(
  guildId: string,
  requestId: number,
): Promise<DiscordRequest | null> {
  const [request] = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.id, requestId),
      ),
    )
    .limit(1);
  return request ?? null;
}

export function parseRequestId(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(?:REQ-)?(\d{1,10})$/i);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function formatRequestId(id: number): string {
  return `REQ-${String(id).padStart(5, "0")}`;
}

export async function updateRequest(
  requestId: number,
  changes: Partial<
    Pick<
      DiscordRequest,
      | "description"
      | "setupDetails"
      | "status"
      | "stage"
      | "assignedToId"
      | "requestChannelId"
      | "requestMessageId"
      | "threadId"
      | "lastActivityAt"
      | "reminderSentAt"
      | "closedAt"
    >
  >,
): Promise<DiscordRequest> {
  const [request] = await db
    .update(discordRequestsTable)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(discordRequestsTable.id, requestId))
    .returning();
  if (!request) throw new Error(`Request ${requestId} was not found.`);
  return request;
}

export async function listRequests(
  guildId: string,
  filters: RequestFilters = {},
): Promise<DiscordRequest[]> {
  const conditions = [eq(discordRequestsTable.guildId, guildId)];
  if (filters.status) conditions.push(eq(discordRequestsTable.status, filters.status));
  if (filters.memberId) conditions.push(eq(discordRequestsTable.memberId, filters.memberId));
  return db
    .select()
    .from(discordRequestsTable)
    .where(and(...conditions))
    .orderBy(desc(discordRequestsTable.createdAt))
    .limit(filters.pageSize ?? 10)
    .offset(((filters.page ?? 1) - 1) * (filters.pageSize ?? 10));
}

export async function countRecentRequests(
  guildId: string,
  memberId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ id: discordRequestsTable.id })
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        gte(discordRequestsTable.createdAt, since),
      ),
    )
    .limit(4);
  return rows.length;
}

export async function recordRequestEvent(input: {
  requestId: number | null;
  guildId: string;
  actorId: string;
  eventType: string;
  metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await db.insert(discordRequestEventsTable).values({
    ...input,
    metadata: input.metadata ?? {},
  });
}

export async function listRequestEvents(requestId: number) {
  return db
    .select()
    .from(discordRequestEventsTable)
    .where(eq(discordRequestEventsTable.requestId, requestId))
    .orderBy(discordRequestEventsTable.createdAt);
}

export async function findPendingFollowupForMember(
  guildId: string,
  memberId: string,
) {
  const [result] = await db
    .select({
      followup: discordRequestFollowupsTable,
      request: discordRequestsTable,
    })
    .from(discordRequestFollowupsTable)
    .innerJoin(
      discordRequestsTable,
      eq(discordRequestFollowupsTable.requestId, discordRequestsTable.id),
    )
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        eq(discordRequestFollowupsTable.status, "pending"),
        notInArray(discordRequestsTable.status, TERMINAL_STATUSES),
      ),
    )
    .orderBy(desc(discordRequestFollowupsTable.id))
    .limit(1);
  return result ?? null;
}

export async function findPendingFollowupForRequest(requestId: number) {
  const [followup] = await db
    .select()
    .from(discordRequestFollowupsTable)
    .where(
      and(
        eq(discordRequestFollowupsTable.requestId, requestId),
        eq(discordRequestFollowupsTable.status, "pending"),
      ),
    )
    .orderBy(desc(discordRequestFollowupsTable.id))
    .limit(1);
  return followup ?? null;
}

export async function createFollowup(input: {
  requestId: number;
  askedById: string;
  question: string;
}) {
  const [followup] = await db
    .insert(discordRequestFollowupsTable)
    .values(input)
    .returning();
  if (!followup) throw new Error("Follow-up insert returned no row.");
  return followup;
}

export async function answerFollowup(
  followupId: number,
  answer: string,
): Promise<void> {
  await db
    .update(discordRequestFollowupsTable)
    .set({ answer, status: "answered", answeredAt: new Date() })
    .where(
      and(
        eq(discordRequestFollowupsTable.id, followupId),
        eq(discordRequestFollowupsTable.status, "pending"),
      ),
    );
}

export async function setFollowupStatus(
  followupId: number,
  status: "cancelled" | "failed" | "expired",
): Promise<void> {
  await db
    .update(discordRequestFollowupsTable)
    .set({ status })
    .where(eq(discordRequestFollowupsTable.id, followupId));
}

export async function listRequestFollowups(requestId: number) {
  return db
    .select()
    .from(discordRequestFollowupsTable)
    .where(eq(discordRequestFollowupsTable.requestId, requestId))
    .orderBy(discordRequestFollowupsTable.createdAt);
}

export async function addRequestAttachment(input: {
  requestId: number;
  fileName: string;
  contentType: string;
  byteSize: number;
  threadMessageId: string;
}): Promise<void> {
  await db.insert(discordRequestAttachmentsTable).values(input);
}

export async function listRequestAttachments(requestId: number) {
  return db
    .select()
    .from(discordRequestAttachmentsTable)
    .where(eq(discordRequestAttachmentsTable.requestId, requestId))
    .orderBy(discordRequestAttachmentsTable.createdAt);
}

export async function getBotSettings(guildId: string) {
  const [settings] = await db
    .select()
    .from(discordBotSettingsTable)
    .where(eq(discordBotSettingsTable.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

export async function setBotSettings(
  guildId: string,
  changes: {
    logChannelId?: string | null;
    retentionDays?: number | null;
  },
): Promise<void> {
  const current = await getBotSettings(guildId);
  const values = {
    guildId,
    logChannelId:
      changes.logChannelId === undefined
        ? (current?.logChannelId ?? null)
        : changes.logChannelId,
    retentionDays:
      changes.retentionDays === undefined
        ? (current?.retentionDays ?? null)
        : changes.retentionDays,
    updatedAt: new Date(),
  };
  await db
    .insert(discordBotSettingsTable)
    .values(values)
    .onConflictDoUpdate({
      target: discordBotSettingsTable.guildId,
      set: {
        logChannelId: values.logChannelId,
        retentionDays: values.retentionDays,
        updatedAt: values.updatedAt,
      },
    });
}

export async function isCommandAllowed(
  guildId: string,
  userId: string,
  commandName: string,
): Promise<boolean> {
  const grants = await db
    .select({
      commandName: discordCommandPermissionsTable.commandName,
      effect: discordCommandPermissionsTable.effect,
    })
    .from(discordCommandPermissionsTable)
    .where(
      and(
        eq(discordCommandPermissionsTable.guildId, guildId),
        eq(discordCommandPermissionsTable.userId, userId),
        or(
          eq(discordCommandPermissionsTable.commandName, commandName),
          eq(discordCommandPermissionsTable.commandName, "all"),
        ),
      ),
    );

  const exact = grants.find((grant) => grant.commandName === commandName);
  if (exact?.effect === "deny") return false;
  if (exact?.effect === "allow") return true;
  return grants.some(
    (grant) => grant.commandName === "all" && grant.effect === "allow",
  );
}

export async function grantCommandPermission(input: {
  guildId: string;
  commandName: string;
  userId: string;
  grantedById: string;
}): Promise<void> {
  if (input.commandName === "all") {
    await db.transaction(async (tx) => {
      await tx
        .delete(discordCommandPermissionsTable)
        .where(
          and(
            eq(discordCommandPermissionsTable.guildId, input.guildId),
            eq(discordCommandPermissionsTable.userId, input.userId),
          ),
        );
      await tx.insert(discordCommandPermissionsTable).values({
        ...input,
        effect: "allow",
      });
    });
    return;
  }
  await db
    .insert(discordCommandPermissionsTable)
    .values({ ...input, effect: "allow" })
    .onConflictDoUpdate({
      target: [
        discordCommandPermissionsTable.guildId,
        discordCommandPermissionsTable.commandName,
        discordCommandPermissionsTable.userId,
      ],
      set: { effect: "allow", grantedById: input.grantedById, createdAt: new Date() },
    });
}

export async function revokeCommandPermission(input: {
  guildId: string;
  commandName: string;
  userId: string;
  revokedById: string;
}): Promise<void> {
  if (input.commandName === "all") {
    await db
      .delete(discordCommandPermissionsTable)
      .where(
        and(
          eq(discordCommandPermissionsTable.guildId, input.guildId),
          eq(discordCommandPermissionsTable.userId, input.userId),
        ),
      );
    return;
  }

  await db
    .insert(discordCommandPermissionsTable)
    .values({
      guildId: input.guildId,
      commandName: input.commandName,
      userId: input.userId,
      effect: "deny",
      grantedById: input.revokedById,
    })
    .onConflictDoUpdate({
      target: [
        discordCommandPermissionsTable.guildId,
        discordCommandPermissionsTable.commandName,
        discordCommandPermissionsTable.userId,
      ],
      set: { effect: "deny", grantedById: input.revokedById, createdAt: new Date() },
    });
}

export async function listCommandPermissions(guildId: string, userId?: string) {
  const conditions = [eq(discordCommandPermissionsTable.guildId, guildId)];
  if (userId) conditions.push(eq(discordCommandPermissionsTable.userId, userId));
  return db
    .select()
    .from(discordCommandPermissionsTable)
    .where(and(...conditions))
    .orderBy(discordCommandPermissionsTable.userId);
}

export async function listRequestsForMaintenance(guildId: string) {
  return db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        inArray(discordRequestsTable.status, ["awaiting_member", "waiting_on_member"]),
      ),
    )
    .orderBy(discordRequestsTable.lastActivityAt)
    .limit(200);
}

export async function deleteRetainedRequests(
  guildId: string,
  cutoff: Date,
): Promise<number> {
  const removed = await db
    .delete(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        inArray(discordRequestsTable.status, TERMINAL_STATUSES),
        lt(discordRequestsTable.closedAt, cutoff),
      ),
    )
    .returning({ id: discordRequestsTable.id });
  return removed.length;
}

export async function listAllRequestsForBackup(guildId: string) {
  const requests = await db
    .select()
    .from(discordRequestsTable)
    .where(eq(discordRequestsTable.guildId, guildId))
    .orderBy(discordRequestsTable.id);
  const followups = await db
    .select()
    .from(discordRequestFollowupsTable)
    .innerJoin(
      discordRequestsTable,
      eq(discordRequestFollowupsTable.requestId, discordRequestsTable.id),
    )
    .where(eq(discordRequestsTable.guildId, guildId));
  const events = await db
    .select()
    .from(discordRequestEventsTable)
    .where(eq(discordRequestEventsTable.guildId, guildId))
    .orderBy(discordRequestEventsTable.id);
  const attachments = await db
    .select()
    .from(discordRequestAttachmentsTable)
    .innerJoin(
      discordRequestsTable,
      eq(discordRequestAttachmentsTable.requestId, discordRequestsTable.id),
    )
    .where(eq(discordRequestsTable.guildId, guildId));
  return { requests, followups, events, attachments };
}

export async function listAllRequestData(guildId: string, requestId: number) {
  const [request, followups, events, attachments] = await Promise.all([
    findRequestByIdForExport(guildId, requestId),
    listRequestFollowups(requestId),
    listRequestEvents(requestId),
    listRequestAttachments(requestId),
  ]);
  return { request, followups, events, attachments };
}

async function findRequestByIdForExport(guildId: string, requestId: number) {
  const [request] = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.id, requestId),
        eq(discordRequestsTable.guildId, guildId),
      ),
    )
    .limit(1);
  return request ?? null;
}

