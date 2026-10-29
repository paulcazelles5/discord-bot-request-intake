import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  discordRequestAttachmentsTable,
  discordRequestEventsTable,
  discordRequestFollowupsTable,
  discordRequestsTable,
  discordBotSettingsTable,
  discordCommandPermissionsTable,
  discordOwnerAccessTable,
  discordRequestLimitBypassesTable,
} from "@workspace/db";
import { db } from "@workspace/db";

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

export async function verifyStoreReady(): Promise<void> {
  await db.select().from(discordBotSettingsTable).limit(1);
}

export function parseRequestId(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(?:REQ-)?0*(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRequestId(id: number): string {
  return `REQ-${String(id).padStart(5, "0")}`;
}

export async function findRequestById(guildId: string, id: number) {
  const rows = await db
    .select()
    .from(discordRequestsTable)
    .where(and(eq(discordRequestsTable.guildId, guildId), eq(discordRequestsTable.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRequests(
  guildId: string,
  filters: {
    status?: RequestStatus;
    memberId?: string;
    page?: number;
    pageSize?: number;
    limit?: number;
    offset?: number;
    sort?: "newest" | "oldest" | "status";
  } = {},
) {
  const pageSize = filters.pageSize ?? filters.limit ?? 20;
  const page = filters.page ?? 1;
  const offset = filters.offset ?? (page - 1) * pageSize;
  const sort = filters.sort ?? "newest";
  const conditions = [eq(discordRequestsTable.guildId, guildId)];
  if (filters.status) conditions.push(eq(discordRequestsTable.status, filters.status));
  if (filters.memberId) conditions.push(eq(discordRequestsTable.memberId, filters.memberId));
  let order;
  if (sort === "oldest") order = asc(discordRequestsTable.createdAt);
  else if (sort === "status") order = asc(discordRequestsTable.status);
  else order = desc(discordRequestsTable.createdAt);
  return db
    .select()
    .from(discordRequestsTable)
    .where(and(...conditions))
    .orderBy(order)
    .limit(pageSize)
    .offset(offset);
}

export async function countRequests(
  guildId: string,
  filters: { status?: RequestStatus; memberId?: string } = {},
): Promise<number> {
  const conditions = [eq(discordRequestsTable.guildId, guildId)];
  if (filters.status) conditions.push(eq(discordRequestsTable.status, filters.status));
  if (filters.memberId) conditions.push(eq(discordRequestsTable.memberId, filters.memberId));
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discordRequestsTable)
    .where(and(...conditions));
  return rows[0]?.n ?? 0;
}

export async function countRequestsByStatus(guildId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: discordRequestsTable.status,
      n: sql<number>`count(*)::int`,
    })
    .from(discordRequestsTable)
    .where(eq(discordRequestsTable.guildId, guildId))
    .groupBy(discordRequestsTable.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function updateRequest(
  id: number,
  patch: Partial<{
    status: RequestStatus;
    stage: string;
    threadId: string | null;
    assignedToId: string | null;
    description: string;
    setupDetails: string;
    title: string;
    summary: string;
  }>,
) {
  const rows = await db
    .update(discordRequestsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(discordRequestsTable.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function createFollowup(input: {
  requestId: number;
  askedById: string;
  question: string;
}) {
  const rows = await db
    .insert(discordRequestFollowupsTable)
    .values({
      requestId: input.requestId,
      askedById: input.askedById,
      question: input.question,
      status: "pending",
    })
    .returning();
  return rows[0];
}

export async function recordRequestEvent(input: {
  requestId: number;
  eventType: string;
  actorId?: string | null;
  details?: string | null;
}) {
  await db.insert(discordRequestEventsTable).values({
    requestId: input.requestId,
    eventType: input.eventType,
    actorId: input.actorId ?? null,
    details: input.details ?? null,
  });
}

export async function createRequest(input: {
  guildId: string;
  memberId: string;
  memberTag?: string | null;
  description: string;
  status?: RequestStatus;
  stage?: string;
}) {
  const rows = await db
    .insert(discordRequestsTable)
    .values({
      guildId: input.guildId,
      memberId: input.memberId,
      memberTag: input.memberTag ?? null,
      description: input.description,
      status: input.status ?? "received",
      stage: input.stage ?? "intake",
    })
    .returning();
  return rows[0];
}

export async function findActiveRequestForMember(guildId: string, memberId: string) {
  const open = [
    "awaiting_member",
    "waiting_on_member",
    "received",
    "needs_info",
    "accepted",
    "in_progress",
  ] as RequestStatus[];
  const rows = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        inArray(discordRequestsTable.status, open),
      ),
    )
    .orderBy(desc(discordRequestsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPendingMemberFlowForMember(guildId: string, memberId: string) {
  return findActiveRequestForMember(guildId, memberId);
}

export async function getRequestDailyLimit(guildId: string): Promise<number> {
  const rows = await db
    .select()
    .from(discordBotSettingsTable)
    .where(eq(discordBotSettingsTable.guildId, guildId))
    .limit(1);
  return rows[0]?.requestDailyLimit ?? 3;
}

export async function setRequestDailyLimit(guildId: string, limit: number): Promise<void> {
  await db
    .insert(discordBotSettingsTable)
    .values({ guildId, requestDailyLimit: limit })
    .onConflictDoUpdate({
      target: discordBotSettingsTable.guildId,
      set: { requestDailyLimit: limit },
    });
}

export async function hasRequestLimitBypass(guildId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(discordRequestLimitBypassesTable)
    .where(
      and(
        eq(discordRequestLimitBypassesTable.guildId, guildId),
        eq(discordRequestLimitBypassesTable.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function setRequestLimitBypass(input: {
  guildId: string;
  userId: string;
  enabled: boolean;
}): Promise<void> {
  if (input.enabled) {
    await db
      .insert(discordRequestLimitBypassesTable)
      .values({ guildId: input.guildId, userId: input.userId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(discordRequestLimitBypassesTable)
      .where(
        and(
          eq(discordRequestLimitBypassesTable.guildId, input.guildId),
          eq(discordRequestLimitBypassesTable.userId, input.userId),
        ),
      );
  }
}

export async function countRecentRequests(guildId: string, memberId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        gte(discordRequestsTable.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function listRequestEvents(requestId: number) {
  return db
    .select()
    .from(discordRequestEventsTable)
    .where(eq(discordRequestEventsTable.requestId, requestId))
    .orderBy(asc(discordRequestEventsTable.createdAt));
}

export async function findPendingFollowupForMember(guildId: string, memberId: string) {
  const rows = await db
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
      ),
    )
    .orderBy(desc(discordRequestFollowupsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPendingFollowupForRequest(requestId: number) {
  const rows = await db
    .select()
    .from(discordRequestFollowupsTable)
    .where(
      and(
        eq(discordRequestFollowupsTable.requestId, requestId),
        eq(discordRequestFollowupsTable.status, "pending"),
      ),
    )
    .orderBy(desc(discordRequestFollowupsTable.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function answerFollowup(id: number, answer: string) {
  const rows = await db
    .update(discordRequestFollowupsTable)
    .set({ status: "answered", answer, answeredAt: new Date() })
    .where(eq(discordRequestFollowupsTable.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function setFollowupStatus(id: number, status: string) {
  const rows = await db
    .update(discordRequestFollowupsTable)
    .set({ status })
    .where(eq(discordRequestFollowupsTable.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function listRequestFollowups(requestId: number) {
  return db
    .select()
    .from(discordRequestFollowupsTable)
    .where(eq(discordRequestFollowupsTable.requestId, requestId))
    .orderBy(asc(discordRequestFollowupsTable.createdAt));
}

export async function addRequestAttachment(input: {
  requestId: number;
  fileName: string;
  contentType: string;
  byteSize: number;
  threadMessageId?: string | null;
  url?: string | null;
}) {
  const rows = await db
    .insert(discordRequestAttachmentsTable)
    .values({
      requestId: input.requestId,
      fileName: input.fileName,
      contentType: input.contentType,
      byteSize: input.byteSize,
      threadMessageId: input.threadMessageId ?? null,
      url: input.url ?? null,
    })
    .returning();
  return rows[0];
}

export async function listRequestAttachments(requestId: number) {
  return db
    .select()
    .from(discordRequestAttachmentsTable)
    .where(eq(discordRequestAttachmentsTable.requestId, requestId));
}

export async function getBotSettings(guildId: string) {
  const rows = await db
    .select()
    .from(discordBotSettingsTable)
    .where(eq(discordBotSettingsTable.guildId, guildId))
    .limit(1);
  return rows[0] ?? null;
}

export async function setBotSettings(
  guildId: string,
  patch: Partial<{ requestDailyLimit: number; listChannelId: string | null }>,
) {
  await db
    .insert(discordBotSettingsTable)
    .values({ guildId, ...patch })
    .onConflictDoUpdate({
      target: discordBotSettingsTable.guildId,
      set: patch,
    });
}

export async function isCommandAllowed(
  guildId: string,
  userId: string,
  command: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(discordCommandPermissionsTable)
    .where(
      and(
        eq(discordCommandPermissionsTable.guildId, guildId),
        eq(discordCommandPermissionsTable.commandName, command),
        or(
          eq(discordCommandPermissionsTable.userId, userId),
          eq(discordCommandPermissionsTable.userId, "*"),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function hasOwnerAccess(guildId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(discordOwnerAccessTable)
    .where(
      and(
        eq(discordOwnerAccessTable.guildId, guildId),
        eq(discordOwnerAccessTable.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function grantOwnerAccess(input: { guildId: string; userId: string }) {
  await db
    .insert(discordOwnerAccessTable)
    .values({ guildId: input.guildId, userId: input.userId })
    .onConflictDoNothing();
}

export async function grantCommandPermission(input: {
  guildId: string;
  command: string;
  userId: string;
}) {
  await db
    .insert(discordCommandPermissionsTable)
    .values({
      guildId: input.guildId,
      command: input.command,
      userId: input.userId,
    })
    .onConflictDoNothing();
}

export async function revokeCommandPermission(input: {
  guildId: string;
  command: string;
  userId: string;
}) {
  await db
    .delete(discordCommandPermissionsTable)
    .where(
      and(
        eq(discordCommandPermissionsTable.guildId, input.guildId),
        eq(discordCommandPermissionsTable.commandName, input.command),
        eq(discordCommandPermissionsTable.userId, input.userId),
      ),
    );
}

/**
 * Delete closed requests older than the configured retention period.
 * Accepts either a number of days or an explicit cutoff date.
 * Open requests are never deleted.
 */
export async function deleteRetainedRequests(
  guildId: string,
  retention: number | Date | null | undefined,
): Promise<number> {
  if (retention == null || retention === 0) return 0;
  const cutoff =
    retention instanceof Date
      ? retention
      : new Date(Date.now() - Math.max(1, retention) * 24 * 60 * 60 * 1000);
  if (Number.isNaN(cutoff.getTime())) return 0;

  const closedStatuses: RequestStatus[] = [
    "completed",
    "declined",
    "cancelled",
    "expired",
  ];
  const deleted = await db
    .delete(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        inArray(discordRequestsTable.status, closedStatuses),
        lt(discordRequestsTable.closedAt, cutoff),
      ),
    )
    .returning({ id: discordRequestsTable.id });
  return deleted.length;
}

/** Return all request records for a guild, newest first, for backup/export tools. */
export async function listAllRequestData(guildId: string) {
  const requests = await db
    .select()
    .from(discordRequestsTable)
    .where(eq(discordRequestsTable.guildId, guildId))
    .orderBy(desc(discordRequestsTable.createdAt));
  return requests;
}

/** Compatibility alias used by the bot's backup command. */
export async function listAllRequestsForBackup(guildId: string) {
  return listAllRequestData(guildId);
}

/** List explicit command grants/overrides for a guild, optionally for one user. */
export async function listCommandPermissions(guildId: string, userId?: string) {
  const conditions = [eq(discordCommandPermissionsTable.guildId, guildId)];
  if (userId) conditions.push(eq(discordCommandPermissionsTable.userId, userId));
  return db
    .select()
    .from(discordCommandPermissionsTable)
    .where(and(...conditions))
    .orderBy(asc(discordCommandPermissionsTable.commandName));
}

