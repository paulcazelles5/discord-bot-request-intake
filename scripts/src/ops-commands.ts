import {
  type Client,
  type Message,
} from "discord.js";
import {
  countRequestsByStatus,
  createFollowup,
  findPendingFollowupForRequest,
  findRequestById,
  formatRequestId,
  listRequestEvents,
  listRequests,
  parseRequestId,
  recordRequestEvent,
  setFollowupStatus,
  updateRequest,
  verifyStoreReady,
} from "./request-store.js";

const noMentions = { parse: [] as const };
const STARTED_AT = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

export const groqStats = {
  calls: 0,
  successes: 0,
  failures: 0,
  lastCallAt: null as number | null,
  lastError: null as string | null,
  lastLatencyMs: null as number | null,
  totalTokensApprox: 0,
};

export function recordGroqCall(result: {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  tokensApprox?: number;
}): void {
  groqStats.calls += 1;
  groqStats.lastCallAt = Date.now();
  if (result.latencyMs != null) groqStats.lastLatencyMs = result.latencyMs;
  if (result.ok) {
    groqStats.successes += 1;
    if (result.tokensApprox) groqStats.totalTokensApprox += result.tokensApprox;
  } else {
    groqStats.failures += 1;
    groqStats.lastError = result.error ?? "unknown";
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

export async function handleFindCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  const query = args.slice(1).join(" ").trim();
  if (!query) {
    await message.reply({
      content:
        "Usage: `!find REQ-00012` or `!find <user-id>` or `!find <keyword>`.\n" +
        "Members only see their own matches; staff see all.",
      allowedMentions: noMentions,
    });
    return;
  }

  const asId = parseRequestId(query);
  const mentionId = query.match(/^<@!?(\d+)>$/)?.[1];
  const rawUserId = /^\d{5,22}$/.test(query) ? query : mentionId;

  if (asId) {
    const request = await findRequestById(options.guildId, asId);
    if (!request) {
      await message.reply({ content: `No request **${formatRequestId(asId)}**.`, allowedMentions: noMentions });
      return;
    }
    if (!options.isStaff && request.memberId !== message.author.id) {
      await message.reply({ content: "You can only look up your own requests.", allowedMentions: noMentions });
      return;
    }
    const lines = [
      `**${formatRequestId(request.id)}**`,
      `Status: \`${request.status}\` · Stage: \`${request.stage}\``,
      `Member: <@${request.memberId}> (\`${request.memberId}\`)`,
      request.assignedToId ? `Assigned: <@${request.assignedToId}>` : "Assigned: —",
      `Created: \`${new Date(request.createdAt).toISOString()}\``,
      request.description ? `Description: ${String(request.description).slice(0, 300)}` : "Description: —",
    ];
    await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
    return;
  }

  if (rawUserId) {
    if (!options.isStaff && rawUserId !== message.author.id) {
      await message.reply({ content: "You can only look up your own requests.", allowedMentions: noMentions });
      return;
    }
    const rows = await listRequests(options.guildId, {
      memberId: rawUserId,
      page: 1,
      pageSize: 20,
      sort: "newest",
    });
    if (rows.length === 0) {
      await message.reply({ content: `No requests for \`${rawUserId}\`.`, allowedMentions: noMentions });
      return;
    }
    const lines = [
      `**Requests for** <@${rawUserId}> — ${rows.length}${rows.length >= 20 ? "+" : ""}`,
      ...rows.map(
        (r) =>
          `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${new Date(r.createdAt).toISOString().slice(0, 10)}`,
      ),
    ];
    await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
    return;
  }

  const pool = options.isStaff
    ? await listRequests(options.guildId, { page: 1, pageSize: 50, sort: "newest" })
    : await listRequests(options.guildId, {
        memberId: message.author.id,
        page: 1,
        pageSize: 50,
        sort: "newest",
      });
  const q = query.toLowerCase();
  const matched = pool.filter((r) => {
    const desc = String(r.description ?? "").toLowerCase();
    return desc.includes(q) || formatRequestId(r.id).toLowerCase().includes(q);
  });
  if (matched.length === 0) {
    await message.reply({
      content: options.isStaff
        ? `No match for \`${query}\` in recent requests.`
        : `No match for \`${query}\` in your requests.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const lines = [
    `**Matches for** \`${query}\` (${matched.length})`,
    ...matched.slice(0, 15).map(
      (r) =>
        `• **${formatRequestId(r.id)}** · <@${r.memberId}> · \`${r.status}\` · ${String(r.description ?? "").slice(0, 60)}`,
    ),
  ];
  await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
}

export async function handleStatsCommand(
  message: Message,
  options: { guildId: string },
): Promise<void> {
  const byStatus = await countRequestsByStatus(options.guildId);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const statusLines = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `• \`${status}\` — **${count}**`)
    .join("\n");
  const content = [
    "**Request stats**",
    `Total: **${total}**`,
    "",
    "**By status**",
    statusLines || "_none_",
    "",
    "**Groq (this process)**",
    `Calls: **${groqStats.calls}** · OK: **${groqStats.successes}** · Fail: **${groqStats.failures}**`,
  ].join("\n");
  await message.reply({ content: content.slice(0, 1900), allowedMentions: noMentions });
}

export async function handleHealthcheckCommand(
  message: Message,
  options: {
    client: Client;
    guildId: string;
    groqApiKey?: string | null;
    groqModel?: string;
    ownerId: string;
  },
): Promise<void> {
  const mem = process.memoryUsage();
  let dbOk = false;
  let dbError = "";
  try {
    await verifyStoreReady();
    dbOk = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  const guild = await options.client.guilds.fetch(options.guildId).catch(() => null);
  const listChannel = guild?.channels.cache.find(
    (c) => c.isTextBased() && "name" in c && c.name === "・list",
  );
  const lines = [
    "**Healthcheck**",
    `Uptime: ${formatUptime(Date.now() - STARTED_AT)}`,
    `Memory RSS: ${Math.round(mem.rss / 1024 / 1024)} MB · heap ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
    `Discord: ${options.client.user?.tag ?? "?"} · ping ${options.client.ws.ping}ms`,
    `Guild: ${guild ? `✅ ${guild.name}` : "❌ missing"}`,
    `Database: ${dbOk ? "✅ ready" : `❌ ${dbError.slice(0, 120)}`}`,
    `Groq key: ${options.groqApiKey ? "✅ set" : "❌ missing"}` +
      (options.groqModel ? ` · model \`${options.groqModel}\`` : ""),
    `• List channel \`・list\`: ${listChannel ? `✅ <#${listChannel.id}>` : "❌ not found"}`,
  ];
  await message.reply({ content: lines.join("\n"), allowedMentions: noMentions });
}

export async function handleMyRequestsCommand(
  message: Message,
  options: { guildId: string },
): Promise<void> {
  const rows = await listRequests(options.guildId, {
    memberId: message.author.id,
    page: 1,
    pageSize: 25,
    sort: "newest",
  });
  if (!rows.length) {
    await message.reply({ content: "You have no requests yet.", allowedMentions: noMentions });
    return;
  }
  const lines = rows.map(
    (r) =>
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${new Date(r.createdAt).toISOString().slice(0, 10)} · ${String(r.description ?? "").slice(0, 50)}`,
  );
  await message.reply({
    content: `**Your requests** (${rows.length})\n${lines.join("\n")}`.slice(0, 1900),
    allowedMentions: noMentions,
  });
}

const MEMBER_NUDGE_SCHEDULE = [
  { afterMs: 1 * DAY_MS, event: "member_nudge_d1", warn: false },
  { afterMs: 5 * DAY_MS, event: "member_nudge_d5", warn: false },
  { afterMs: 9 * DAY_MS, event: "member_nudge_d9", warn: true },
];

export type OpsMaintenanceDeps = {
  client: Client;
  guildId: string;
  botUserId?: string;
  notifyMember?: (request: { id: number; memberId: string }, text: string) => Promise<void>;
  postInRequestThread?: (request: { id: number; threadId: string | null }, text: string) => Promise<void>;
  postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
};

async function hasEvent(requestId: number, eventType: string): Promise<boolean> {
  const events = await listRequestEvents(requestId);
  return events.some((e) => e.eventType === eventType);
}

/** Member follow-up schedule (J+1 / J+5 / J+9 / expire J+10) + staff thread nudges. */
export async function processOpsMaintenance(deps: OpsMaintenanceDeps): Promise<void> {
  const openStatuses = new Set([
    "awaiting_member",
    "waiting_on_member",
    "received",
    "needs_info",
    "accepted",
    "in_progress",
  ]);
  const open = await listRequests(deps.guildId, { page: 1, pageSize: 100, sort: "oldest" });
  const candidates = open.filter((r) => openStatuses.has(r.status));

  for (const request of candidates) {
    const followup = await findPendingFollowupForRequest(request.id);
    if (!followup) continue;
    const age = Date.now() - new Date(followup.createdAt).getTime();

    if (age >= 10 * DAY_MS) {
      if (!(await hasEvent(request.id, "request_expired"))) {
        await setFollowupStatus(followup.id, "expired");
        await updateRequest(request.id, {
          status: "expired",
          stage: "complete",
          closedAt: new Date(),
          lastActivityAt: new Date(),
        });
        await recordRequestEvent({
          requestId: request.id,
          eventType: "request_expired",
          actorId: deps.botUserId ?? null,
          details: "member_no_reply_10d",
        });
        const msg =
          `**${formatRequestId(request.id)}** a expiré : aucune réponse après 10 jours.\n` +
          `Pour recommencer, utilise \`!request\` dans le serveur.`;
        if (deps.notifyMember) await deps.notifyMember(request, msg).catch(() => undefined);
        if (deps.postInRequestThread) {
          await deps
            .postInRequestThread(
              request,
              `⏳ ${formatRequestId(request.id)} **expiré** (membre sans réponse après 10 jours).`,
            )
            .catch(() => undefined);
        }
      }
      continue;
    }

    for (const step of MEMBER_NUDGE_SCHEDULE) {
      if (age < step.afterMs) continue;
      if (await hasEvent(request.id, step.event)) continue;
      const dayLabel = Math.round(step.afterMs / DAY_MS);
      let content =
        `Rappel concernant **${formatRequestId(request.id)}** : l'équipe attend toujours ta réponse.\n\n` +
        `**Question :** ${followup.question}\n\n` +
        `Réponds en DM ou utilise \`!resume\` dans le serveur.`;
      if (step.warn) {
        content +=
          `\n\n⚠️ **Attention** : sans réponse d'ici demain, cette demande sera **automatiquement expirée**.`;
      }
      try {
        if (deps.notifyMember) await deps.notifyMember(request, content);
        await recordRequestEvent({
          requestId: request.id,
          eventType: step.event,
          actorId: deps.botUserId ?? null,
          details: `day=${dayLabel};followup=${followup.id}`,
        });
        if (deps.postInRequestThread) {
          await deps
            .postInRequestThread(
              request,
              `🔔 Rappel membre J+${dayLabel} envoyé pour ${formatRequestId(request.id)}.` +
                (step.warn ? " (avertissement expiration J+10)" : ""),
            )
            .catch(() => undefined);
        }
      } catch {
        // ignore
      }
      break;
    }
  }

  for (const request of candidates) {
    if (!request.threadId) continue;
    const idleMs = Date.now() - new Date(request.lastActivityAt ?? request.updatedAt).getTime();
    if (idleMs < 3 * DAY_MS) continue;
    if (await hasEvent(request.id, "staff_thread_nudge")) continue;
    if (deps.postInRequestThread) {
      try {
        await deps.postInRequestThread(
          request,
          `📢 Ping staff : **${formatRequestId(request.id)}** inactive depuis ${Math.floor(idleMs / DAY_MS)} jours.`,
        );
        await recordRequestEvent({
          requestId: request.id,
          eventType: "staff_thread_nudge",
          actorId: deps.botUserId ?? null,
          details: `idleDays=${Math.floor(idleMs / DAY_MS)}`,
        });
      } catch {
        // ignore
      }
    }
  }
}

export async function askMemberForInfo(input: {
  guildId: string;
  requestId: number;
  askedById: string;
  question: string;
  client: Client;
  postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
}): Promise<{ ok: true; requestId: number } | { ok: false; error: string }> {
  const request = await findRequestById(input.guildId, input.requestId);
  if (!request) return { ok: false, error: `Request **${formatRequestId(input.requestId)}** not found.` };

  await createFollowup({
    requestId: request.id,
    askedById: input.askedById,
    question: input.question,
  });
  await updateRequest(request.id, { status: "needs_info" });
  await recordRequestEvent({
    requestId: request.id,
    eventType: "info_requested",
    actorId: input.askedById,
    details: input.question.slice(0, 500),
  });

  if (input.postRequestUpdate) {
    await input.postRequestUpdate(
      request,
      `❓ **Info requested** by <@${input.askedById}>:\n${input.question}`,
    );
  }

  try {
    const user = await input.client.users.fetch(request.memberId);
    await user.send({
      content:
        `We need more info for your request **${formatRequestId(request.id)}**:\n\n` +
        `> ${input.question}\n\n` +
        `Reply here or use the designated channel. Thanks!`,
      allowedMentions: noMentions,
    });
  } catch {
    // DM closed
  }

  return { ok: true, requestId: request.id };
}
