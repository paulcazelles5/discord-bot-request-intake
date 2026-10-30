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
  db,
  discordBotSettingsTable,
  discordCommandPermissionsTable,
  discordOwnerAccessTable,
  discordRequestAttachmentsTable,
  discordRequestEventsTable,
  discordRequestFollowupsTable,
  discordRequestLimitBypassesTable,
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
  /** newest (default) | oldest | status */
  sort?: "newest" | "oldest" | "status";
}

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

export async function getRequestDailyLimit(guildId: string): Promise<number> {
  const [row] = await db
    .select()
    .from(discordBotSettingsTable)
    .where(eq(discordBotSettingsTable.guildId, guildId))
    .limit(1);
  return row?.requestDailyLimit ?? 3;
}

export async function setRequestDailyLimit(guildId: string, limit: number): Promise<void> {
  await db
    .insert(discordBotSettingsTable)
    .values({ guildId, requestDailyLimit: limit, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: discordBotSettingsTable.guildId,
      set: { requestDailyLimit: limit, updatedAt: new Date() },
    });
}

export async function hasRequestLimitBypass(guildId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(discordRequestLimitBypassesTable)
    .where(
      and(
        eq(discordRequestLimitBypassesTable.guildId, guildId),
        eq(discordRequestLimitBypassesTable.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function setRequestLimitBypass(input: {
  guildId: string;
  userId: string;
  grantedById: string;
  enabled: boolean;
}): Promise<void> {
  if (!input.enabled) {
    await db
      .delete(discordRequestLimitBypassesTable)
      .where(
        and(
          eq(discordRequestLimitBypassesTable.guildId, input.guildId),
          eq(discordRequestLimitBypassesTable.userId, input.userId),
        ),
      );
    return;
  }
  await db
    .insert(discordRequestLimitBypassesTable)
    .values({ guildId: input.guildId, userId: input.userId })
    .onConflictDoNothing();
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
      guildId: input.guildId,
      memberId: input.memberId,
      memberTag: input.memberTag,
      description: "",
      setupDetails: "",
      status: "awaiting_member",
      stage: "request",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    })
    .returning();
  return request!;
}

export async function findActiveRequestForMember(
  guildId: string,
  memberId: string,
) {
  const open = [
    "awaiting_member",
    "waiting_on_member",
    "received",
    "needs_info",
    "accepted",
    "in_progress",
  ];
  const [row] = await db
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
  return row ?? null;
}

export async function findPendingMemberFlowForMember(
  guildId: string,
  memberId: string,
) {
  return findActiveRequestForMember(guildId, memberId);
}

export async function findRequestById(guildId: string, id: number) {
  const [row] = await db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateRequest(
  id: number,
  patch: Partial<{
    description: string;
    setupDetails: string;
    status: string;
    stage: string;
    assignedToId: string | null;
    requestChannelId: string | null;
    requestMessageId: string | null;
    threadId: string | null;
    reminderSentAt: Date | null;
    closedAt: Date | null;
    lastActivityAt: Date;
  }>,
) {
  const [row] = await db
    .update(discordRequestsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(discordRequestsTable.id, id))
    .returning();
  return row!;
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
  const conditions = [eq(discordRequestsTable.guildId, guildId)];
  const pageSize = filters.pageSize ?? filters.limit ?? 20;
  const page = filters.page ?? 1;
  const offset = filters.offset ?? (page - 1) * pageSize;
  const sort = filters.sort ?? "newest";

  if (filters.status) conditions.push(eq(discordRequestsTable.status, filters.status));
  if (filters.memberId) conditions.push(eq(discordRequestsTable.memberId, filters.memberId));

  const order =
    sort === "oldest"
      ? asc(discordRequestsTable.createdAt)
      : sort === "status"
        ? asc(discordRequestsTable.status)
        : desc(discordRequestsTable.createdAt);

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
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discordRequestsTable)
    .where(and(...conditions));
  return row?.n ?? 0;
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

export async function countRecentRequests(guildId: string, memberId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        eq(discordRequestsTable.memberId, memberId),
        gte(discordRequestsTable.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

export async function recordRequestEvent(input: {
  requestId: number | null;
  guildId: string;
  actorId: string;
  eventType: string;
  metadata?: Record<string, string | number | boolean | null>;
  details?: string;
}) {
  await db.insert(discordRequestEventsTable).values({
    requestId: input.requestId,
    guildId: input.guildId,
    actorId: input.actorId,
    eventType: input.eventType,
    metadata: input.metadata ?? (input.details ? { details: input.details } : {}),
  });
}

export async function listRequestEvents(requestId: number) {
  return db
    .select()
    .from(discordRequestEventsTable)
    .where(eq(discordRequestEventsTable.requestId, requestId))
    .orderBy(discordRequestEventsTable.createdAt);
}

export async function findPendingFollowupForMember(guildId: string, memberId: string) {
  const [row] = await db
    .select({ followup: discordRequestFollowupsTable })
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
  return row?.followup ?? null;
}

export async function findPendingFollowupForRequest(requestId: number) {
  const [row] = await db
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
  return row ?? null;
}

export async function createFollowup(input: {
  requestId: number;
  askedById: string;
  question: string;
}) {
  const [row] = await db
    .insert(discordRequestFollowupsTable)
    .values({
      requestId: input.requestId,
      askedById: input.askedById,
      question: input.question,
      status: "pending",
    })
    .returning();
  return row!;
}

export async function answerFollowup(id: number, answer: string) {
  await db
    .update(discordRequestFollowupsTable)
    .set({ answer, status: "answered", answeredAt: new Date() })
    .where(
      and(
        eq(discordRequestFollowupsTable.id, id),
        eq(discordRequestFollowupsTable.status, "pending"),
      ),
    );
}

export async function setFollowupStatus(id: number, status: string) {
  await db
    .update(discordRequestFollowupsTable)
    .set({ status })
    .where(eq(discordRequestFollowupsTable.id, id));
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
}) {
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
    listChannelId?: string | null;
    requestDailyLimit?: number;
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
    listChannelId:
      changes.listChannelId === undefined
        ? (current?.listChannelId ?? null)
        : changes.listChannelId,
    requestDailyLimit:
      changes.requestDailyLimit === undefined
        ? (current?.requestDailyLimit ?? 3)
        : changes.requestDailyLimit,
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
        listChannelId: values.listChannelId,
        requestDailyLimit: values.requestDailyLimit,
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

export async function hasOwnerAccess(guildId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(discordOwnerAccessTable)
    .where(
      and(
        eq(discordOwnerAccessTable.guildId, guildId),
        eq(discordOwnerAccessTable.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function grantOwnerAccess(input: {
  guildId: string;
  userId: string;
  grantedById: string;
}): Promise<void> {
  await db
    .insert(discordOwnerAccessTable)
    .values({
      guildId: input.guildId,
      userId: input.userId,
      grantedById: input.grantedById,
    })
    .onConflictDoUpdate({
      target: [discordOwnerAccessTable.guildId, discordOwnerAccessTable.userId],
      set: { grantedById: input.grantedById, createdAt: new Date() },
    });
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
    findRequestById(guildId, requestId),
    listRequestFollowups(requestId),
    listRequestEvents(requestId),
    listRequestAttachments(requestId),
  ]);
  return { request, followups, events, attachments };
}

export async function requestHasEvent(
  requestId: number,
  eventType: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: discordRequestEventsTable.id })
    .from(discordRequestEventsTable)
    .where(
      and(
        eq(discordRequestEventsTable.requestId, requestId),
        eq(discordRequestEventsTable.eventType, eventType),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function listPendingFollowupsForMaintenance(guildId: string) {
  return db
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
        eq(discordRequestFollowupsTable.status, "pending"),
      ),
    )
    .limit(200);
}

export async function listStaffNudgeCandidates(guildId: string) {
  return db
    .select()
    .from(discordRequestsTable)
    .where(
      and(
        eq(discordRequestsTable.guildId, guildId),
        inArray(discordRequestsTable.status, ["received", "accepted", "in_progress", "needs_info"]),
      ),
    )
    .orderBy(discordRequestsTable.lastActivityAt)
    .limit(200);
}
