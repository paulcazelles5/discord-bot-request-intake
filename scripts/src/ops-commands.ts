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
  listRequestFollowups,
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
  const wsPing = options.client.ws.ping;

  let dbOk = false;
  let dbError = "";
  let dbMs = 0;
  const dbStart = Date.now();
  try {
    await verifyStoreReady();
    dbOk = true;
    dbMs = Date.now() - dbStart;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
    dbMs = Date.now() - dbStart;
  }

  const guild = await options.client.guilds.fetch(options.guildId).catch(() => null);
  const listChannel = guild?.channels.cache.find(
    (c) => c.isTextBased() && "name" in c && c.name === "・list",
  );
  const requestsChannel = guild?.channels.cache.find(
    (c) => c.isTextBased() && "name" in c && (c.name === "・requests" || c.name.includes("request")),
  );

  let byStatus: Record<string, number> = {};
  try {
    byStatus = await countRequestsByStatus(options.guildId);
  } catch {
    byStatus = {};
  }
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const openStatuses = [
    "awaiting_member",
    "waiting_on_member",
    "received",
    "needs_info",
    "accepted",
    "in_progress",
  ];
  const open = openStatuses.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  const needsInfo = byStatus["needs_info"] ?? 0;
  const awaiting = (byStatus["awaiting_member"] ?? 0) + (byStatus["waiting_on_member"] ?? 0);

  let groqLine = "❌ no API key";
  if (options.groqApiKey) {
    const t0 = Date.now();
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${options.groqApiKey}` },
      });
      const ms = Date.now() - t0;
      groqLine = res.ok
        ? `✅ HTTP ${res.status} (${ms} ms) · model \`${options.groqModel ?? "?"}\``
        : `⚠️ HTTP ${res.status} (${ms} ms)`;
    } catch (e) {
      const ms = Date.now() - t0;
      groqLine = `❌ ${e instanceof Error ? e.message : String(e)} (${ms} ms)`;
    }
  }

  const topStatuses = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `  · \`${s}\`: **${n}**`)
    .join("\n");

  const lines = [
    "**🏥 Healthcheck**",
    "",
    "**Process**",
    `• Uptime: **${formatUptime(Date.now() - STARTED_AT)}** (since <t:${Math.floor(STARTED_AT / 1000)}:R>)`,
    `• Node: \`${process.version}\` · PID \`${process.pid}\``,
    `• Memory RSS: **${Math.round(mem.rss / 1024 / 1024)} MB** · heap **${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)} MB**`,
    "",
    "**Discord**",
    `• Bot: ${options.client.user ? `**${options.client.user.tag}**` : "not ready"} · WS **${wsPing} ms**`,
    `• Guild: ${guild ? `✅ **${guild.name}**` : "❌ missing"} (\`${options.guildId}\`)`,
    `• Panel \`・list\`: ${listChannel ? `✅ <#${listChannel.id}>` : "❌ not found"}`,
    `• Requests channel: ${requestsChannel ? `✅ <#${requestsChannel.id}>` : "⚠️ not found in cache"}`,
    `• Owner: \`${options.ownerId || "unset"}\``,
    "",
    "**Database**",
    `• ${dbOk ? `✅ ready (${dbMs} ms)` : `❌ ${dbError.slice(0, 120)} (${dbMs} ms)`}`,
    `• Requests: **${total}** total · **${open}** open · **${needsInfo}** needs_info · **${awaiting}** awaiting member`,
    topStatuses ? `• By status:\n${topStatuses}` : "• By status: _none_",
    "",
    "**Groq**",
    `• ${groqLine}`,
    `• Session: **${groqStats.calls}** calls (ok ${groqStats.successes} / fail ${groqStats.failures})` +
      (groqStats.lastCallAt
        ? ` · last <t:${Math.floor(groqStats.lastCallAt / 1000)}:R>`
        : " · last never"),
    "",
    "_Maintenance auto: rappels membre J+1/5/9/10 + pings staff (toutes les heures)._",
  ];

  await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
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
    await message.reply({ content: "You don't have any requests yet.", allowedMentions: noMentions });
    return;
  }

  const lines: string[] = [];
  for (const r of rows) {
    const ageDays = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / DAY_MS);
    const pending = await findPendingFollowupForRequest(r.id).catch(() => null);
    const threadPart = r.threadId
      ? ` · [thread](https://discord.com/channels/${options.guildId}/${r.threadId})`
      : "";
    const pendingPart = pending
      ? `\n  ⏳ Question en attente : ${String(pending.question).slice(0, 80)}`
      : "";
    const desc = String(r.description ?? "").replace(/\n/g, " ").slice(0, 50);
    lines.push(
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${ageDays}j` +
        `${threadPart}\n  ${desc || "_sans description_"}${pendingPart}`,
    );
  }

  await message.reply({
    content: `**Tes requêtes** (${rows.length})\n${lines.join("\n")}`.slice(0, 1900),
    allowedMentions: noMentions,
  });
}

/** Member or staff: detailed status for one request.
 * Usage: !status  |  !status REQ-42
 */
export async function handleStatusCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  const query = args.slice(1).join(" ").trim();
  let request =
    query
      ? await (async () => {
          const id = parseRequestId(query);
          if (!id) return null;
          return findRequestById(options.guildId, id);
        })()
      : null;

  if (!request && !query) {
    const mine = await listRequests(options.guildId, {
      memberId: message.author.id,
      page: 1,
      pageSize: 1,
      sort: "newest",
    });
    request = mine[0] ?? null;
  }

  if (!request) {
    await message.reply({
      content: query
        ? `Request not found for \`${query}\`.`
        : "You don't have any requests. Usage: `!status` ou `!status REQ-42`.",
      allowedMentions: noMentions,
    });
    return;
  }

  if (!options.isStaff && request.memberId !== message.author.id) {
    await message.reply({
      content: "You can only view your own requests.",
      allowedMentions: noMentions,
    });
    return;
  }

  const pending = await findPendingFollowupForRequest(request.id).catch(() => null);
  const followups = await listRequestFollowups(request.id).catch(() => []);
  const ageDays = Math.floor((Date.now() - new Date(request.createdAt).getTime()) / DAY_MS);
  const updatedDays = Math.floor((Date.now() - new Date(request.updatedAt).getTime()) / DAY_MS);

  const threadLine = request.threadId
    ? `Thread: https://discord.com/channels/${options.guildId}/${request.threadId}`
    : "Thread: —";

  const lines = [
    `**${formatRequestId(request.id)}**`,
    `Status: \`${request.status}\` · Stage: \`${request.stage}\``,
    `Membre: <@${request.memberId}>`,
    request.assignedToId ? `Assigné: <@${request.assignedToId}>` : "Assigné: —",
    `Créée: <t:${Math.floor(new Date(request.createdAt).getTime() / 1000)}:f> (${ageDays}j)`,
    `MAJ: <t:${Math.floor(new Date(request.updatedAt).getTime() / 1000)}:R> (${updatedDays}j)`,
    threadLine,
    `Description: ${String(request.description ?? "").slice(0, 300) || "—"}`,
  ];

  if (pending) {
    const fAge = Math.floor((Date.now() - new Date(pending.createdAt).getTime()) / DAY_MS);
    lines.push(
      "",
      `**Question en attente** (${fAge}j) :`,
      `> ${String(pending.question).slice(0, 400)}`,
      "_Réponds en DM au bot ou avec `!resume`._",
    );
  } else if (followups.length) {
    const last = followups[followups.length - 1]!;
    lines.push(
      "",
      `Dernier follow-up: \`${last.status}\` — ${String(last.question).slice(0, 120)}`,
    );
  }

  await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
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
          `\n\n⚠️ **Heads up**: if there is no reply by tomorrow, this request will **automatically expire**.`;
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

export async function handleAddThreadCommand(
  message: Message,
  args: string[],
  options: { guildId: string; client: Client; isStaff: boolean },
): Promise<void> {
  if (!options.isStaff) {
    await message.reply({
      content: "Only staff can add a member to a request thread.",
      allowedMentions: noMentions,
    });
    return;
  }

  const tokens = args.slice(1);
  if (tokens.length === 0) {
    await message.reply({
      content:
        "Usage : `!addthread REQ-00042 @user`\n" +
        "Or in the request thread: `!addthread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let targetUserId: string | null = null;
  const otherTokens: string[] = [];
  for (const t of tokens) {
    const mention = t.match(/^<@!?(\d+)>$/);
    if (mention) {
      targetUserId = mention[1]!;
    } else if (/^\d{5,22}$/.test(t)) {
      if (t.length >= 15) {
        targetUserId = t;
      } else {
        otherTokens.push(t);
      }
    } else {
      otherTokens.push(t);
    }
  }

  if (!targetUserId) {
    await message.reply({
      content: "Indique le membre à ajouter : `!addthread REQ-42 @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let threadId: string | null = null;
  let requestLabel = "";
  let requestId: number | null = null;

  for (const t of otherTokens) {
    const id = parseRequestId(t);
    if (id) {
      requestId = id;
      break;
    }
  }

  if (requestId) {
    const request = await findRequestById(options.guildId, requestId);
    if (!request) {
      await message.reply({
        content: `Request **${formatRequestId(requestId)}** not found.`,
        allowedMentions: noMentions,
      });
      return;
    }
    if (!request.threadId) {
      await message.reply({
        content: `**${formatRequestId(requestId)}** does not have a thread yet.`,
        allowedMentions: noMentions,
      });
      return;
    }
    threadId = request.threadId;
    requestLabel = formatRequestId(request.id);
  } else if (message.channel.isThread()) {
    threadId = message.channel.id;
    requestLabel = `thread \`${threadId}\``;
  } else {
    await message.reply({
      content:
        "Précise la requête : `!addthread REQ-42 @user`\n" +
        "Or run the command **inside** the request thread: `!addthread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
    const channel = await options.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      await message.reply({
        content: `Could not find the thread for ${requestLabel}.`,
        allowedMentions: noMentions,
      });
      return;
    }

    if (channel.archived) {
      await channel.setArchived(false).catch(() => undefined);
    }

    await channel.members.add(targetUserId);

    if (requestId) {
      await recordRequestEvent({
        requestId,
        eventType: "thread_member_added",
        actorId: message.author.id,
        details: `user=${targetUserId};thread=${threadId}`,
      }).catch(() => undefined);
    }

    await message.reply({
      content: `✅ Added <@${targetUserId}> to the thread for **${requestLabel}**.`,
      allowedMentions: { users: [targetUserId] },
    });

    await channel
      .send({
        content: `➕ <@${targetUserId}> was added to the thread by <@${message.author.id}>.`,
        allowedMentions: { users: [targetUserId] },
      })
      .catch(() => undefined);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await message.reply({
      content:
        `❌ Could not add the member to the thread.\n` +
        `Make sure the bot has **Manage Threads** permission / access to the thread.\n` +
        `\`${msg.slice(0, 200)}\``,
      allowedMentions: noMentions,
    });
  }
}

export async function handleRemoveThreadCommand(
  message: Message,
  args: string[],
  options: { guildId: string; client: Client; isStaff: boolean },
): Promise<void> {
  if (!options.isStaff) {
    await message.reply({
      content: "Only staff can remove a member from a request thread.",
      allowedMentions: noMentions,
    });
    return;
  }

  const tokens = args.slice(1);
  if (tokens.length === 0) {
    await message.reply({
      content:
        "Usage : `!removethread REQ-00042 @user`\n" +
        "Or in the request thread: `!removethread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let targetUserId: string | null = null;
  const otherTokens: string[] = [];
  for (const t of tokens) {
    const mention = t.match(/^<@!?(\d+)>$/);
    if (mention) {
      targetUserId = mention[1]!;
    } else if (/^\d{5,22}$/.test(t)) {
      if (t.length >= 15) {
        targetUserId = t;
      } else {
        otherTokens.push(t);
      }
    } else {
      otherTokens.push(t);
    }
  }

  if (!targetUserId) {
    await message.reply({
      content: "Indique le membre à retirer : `!removethread REQ-42 @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let threadId: string | null = null;
  let requestLabel = "";
  let requestId: number | null = null;

  for (const t of otherTokens) {
    const id = parseRequestId(t);
    if (id) {
      requestId = id;
      break;
    }
  }

  if (requestId) {
    const request = await findRequestById(options.guildId, requestId);
    if (!request) {
      await message.reply({
        content: `Request **${formatRequestId(requestId)}** not found.`,
        allowedMentions: noMentions,
      });
      return;
    }
    if (!request.threadId) {
      await message.reply({
        content: `**${formatRequestId(requestId)}** does not have a thread.`,
        allowedMentions: noMentions,
      });
      return;
    }
    threadId = request.threadId;
    requestLabel = formatRequestId(request.id);
  } else if (message.channel.isThread()) {
    threadId = message.channel.id;
    requestLabel = `thread \`${threadId}\``;
  } else {
    await message.reply({
      content:
        "Précise la requête : `!removethread REQ-42 @user`\n" +
        "Or run the command **inside** the thread: `!removethread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
    const channel = await options.client.channels.fetch(threadId);
    if (!channel || !channel.isThread()) {
      await message.reply({
        content: `Could not find the thread for ${requestLabel}.`,
        allowedMentions: noMentions,
      });
      return;
    }

    if (channel.archived) {
      await channel.setArchived(false).catch(() => undefined);
    }

    await channel.members.remove(targetUserId);

    if (requestId) {
      await recordRequestEvent({
        requestId,
        eventType: "thread_member_removed",
        actorId: message.author.id,
        details: `user=${targetUserId};thread=${threadId}`,
      }).catch(() => undefined);
    }

    await message.reply({
      content: `✅ Removed <@${targetUserId}> from the thread for **${requestLabel}**.`,
      allowedMentions: { users: [targetUserId] },
    });

    await channel
      .send({
        content: `➖ <@${targetUserId}> was removed from the thread by <@${message.author.id}>.`,
        allowedMentions: { users: [targetUserId] },
      })
      .catch(() => undefined);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await message.reply({
      content:
        `❌ Could not remove the member from the thread.\n` +
        `Vérifie que le bot a **Manage Threads**.\n` +
        `\`${msg.slice(0, 200)}\``,
      allowedMentions: noMentions,
    });
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
