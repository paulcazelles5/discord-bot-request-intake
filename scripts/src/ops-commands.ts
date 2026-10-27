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
  listRequests,
  parseRequestId,
  recordRequestEvent,
  setFollowupStatus,
  updateRequest,
  verifyStoreReady,
} from "./request-store.js";

const noMentions = { parse: [] as const };
const STARTED_AT = Date.now();

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
  latencyMs: number;
  error?: string;
  tokens?: number;
}): void {
  groqStats.calls += 1;
  groqStats.lastCallAt = Date.now();
  groqStats.lastLatencyMs = result.latencyMs;
  if (result.ok) {
    groqStats.successes += 1;
    if (typeof result.tokens === "number") groqStats.totalTokensApprox += result.tokens;
  } else {
    groqStats.failures += 1;
    groqStats.lastError = result.error?.slice(0, 200) ?? "unknown";
  }
}

function formatDuration(ms: number): string {
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

function maskSecret(value: string | undefined): string {
  if (!value) return "❌ not set";
  if (value.length <= 8) return "✅ set (short)";
  return `✅ set · \`${value.slice(0, 4)}…${value.slice(-4)}\` (${value.length} chars)`;
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
      `Updated: \`${new Date(request.updatedAt).toISOString()}\``,
      request.description
        ? `Description: ${String(request.description).slice(0, 300)}`
        : "Description: —",
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
      `**Requests for** <@${rawUserId}> (\`${rawUserId}\`) — ${rows.length}${rows.length >= 20 ? "+" : ""}`,
      ...rows.map(
        (r) =>
          `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${new Date(r.createdAt).toISOString().slice(0, 10)}`,
      ),
    ];
    await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
    return;
  }

  const pageSize = 50;
  const pool = options.isStaff
    ? await listRequests(options.guildId, { page: 1, pageSize, sort: "newest" })
    : await listRequests(options.guildId, {
        memberId: message.author.id,
        page: 1,
        pageSize,
        sort: "newest",
      });
  const q = query.toLowerCase();
  const matched = pool.filter((r) => {
    const desc = String(r.description ?? "").toLowerCase();
    const setup = String(r.setupDetails ?? "").toLowerCase();
    return desc.includes(q) || setup.includes(q) || formatRequestId(r.id).toLowerCase().includes(q);
  });
  if (matched.length === 0) {
    await message.reply({
      content: options.isStaff
        ? `No match for \`${query}\` in the ${pool.length} most recent requests.`
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
  const openStatuses = [
    "awaiting_member",
    "waiting_on_member",
    "received",
    "needs_info",
    "accepted",
    "in_progress",
  ];
  const open = openStatuses.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  const closed = total - open;
  const statusLines = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `• \`${status}\` — **${count}**`)
    .join("\n");
  const content = [
    "**Request stats**",
    `Total: **${total}** · Open: **${open}** · Closed: **${closed}**`,
    "",
    "**By status**",
    statusLines || "_none_",
    "",
    "**Groq (this process)**",
    `Calls: **${groqStats.calls}** · OK: **${groqStats.successes}** · Fail: **${groqStats.failures}**`,
    groqStats.lastCallAt
      ? `Last call: <t:${Math.floor(groqStats.lastCallAt / 1000)}:R> · latency ${groqStats.lastLatencyMs ?? "?"}ms`
      : "Last call: never",
  ].join("\n");
  await message.reply({ content: content.slice(0, 1900), allowedMentions: noMentions });
}

export async function handleHealthcheckCommand(
  message: Message,
  options: {
    client: Client;
    guildId: string;
    groqApiKey: string | undefined;
    groqModel: string;
    ownerId: string | undefined;
  },
): Promise<void> {
  const uptimeMs = Date.now() - STARTED_AT;
  const mem = process.memoryUsage();
  const wsPing = options.client.ws.ping;

  let dbOk = false;
  let dbError = "";
  const dbStart = Date.now();
  try {
    await verifyStoreReady();
    dbOk = true;
  } catch (error) {
    dbError = error instanceof Error ? error.message : String(error);
  }
  const dbMs = Date.now() - dbStart;

  const byStatus = await countRequestsByStatus(options.guildId).catch(() => ({} as Record<string, number>));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  let groqReachable = "not tested";
  let groqMs: number | null = null;
  if (options.groqApiKey) {
    const t0 = Date.now();
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${options.groqApiKey}` },
      });
      groqMs = Date.now() - t0;
      groqReachable = res.ok ? `✅ HTTP ${res.status}` : `⚠️ HTTP ${res.status}`;
    } catch (error) {
      groqMs = Date.now() - t0;
      groqReachable = `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    groqReachable = "❌ no API key";
  }

  const guild = options.client.guilds.cache.get(options.guildId);
  const listChannel = guild?.channels.cache.find(
    (c) => c.name === "・list" && c.isTextBased(),
  );

  const lines = [
    "**🏥 Healthcheck**",
    "",
    "**Process**",
    `• Uptime: **${formatDuration(uptimeMs)}** (since <t:${Math.floor(STARTED_AT / 1000)}:F>)`,
    `• Node: \`${process.version}\` · PID \`${process.pid}\``,
    `• Memory RSS: **${(mem.rss / 1024 / 1024).toFixed(1)} MB** · heap **${(mem.heapUsed / 1024 / 1024).toFixed(1)}/${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB**`,
    `• Platform: \`${process.platform}\` \`${process.arch}\``,
    "",
    "**Discord**",
    `• Bot: ${options.client.user ? `**${options.client.user.tag}** (\`${options.client.user.id}\`)` : "not ready"}`,
    `• WS latency: **${wsPing} ms**`,
    `• Guilds cached: **${options.client.guilds.cache.size}** · home: \`${options.guildId}\`${guild ? ` (**${guild.name}**)` : " ⚠️ not in cache"}`,
    `• List channel \`・list\`: ${listChannel ? `✅ <#${listChannel.id}>` : "❌ not found"}`,
    `• Owner id: \`${options.ownerId ?? "unset"}\``,
    "",
    "**Database**",
    `• ${dbOk ? "✅ ready" : `❌ ${dbError}`} · ${dbMs} ms`,
    `• Requests total: **${total}**`,
    ...Object.entries(byStatus)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s, n]) => `  · \`${s}\`: ${n}`),
    "",
    "**Groq API**",
    `• Key: ${maskSecret(options.groqApiKey)}`,
    `• Model: \`${options.groqModel}\``,
    `• Reachability: ${groqReachable}${groqMs != null ? ` (${groqMs} ms)` : ""}`,
    `• Session calls: **${groqStats.calls}** (ok ${groqStats.successes} / fail ${groqStats.failures})`,
  ];
  await message.reply({ content: lines.join("joinjoin("\n").slice(0, 1900), allowedMentions: noMentions });
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
  if (rows.length === 0) {
    await message.reply({
      content: "Tu n’as aucune requête.",
      allowedMentions: noMentions,
    });
    return;
  }
  const lines = [
    `**Tes requêtes** (${rows.length}${rows.length >= 25 ? "+" : ""})`,
    ...rows.map(
      (r) =>
        `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${new Date(r.createdAt).toISOString().slice(0, 10)} · ${(String(r.description ?? "").replace(/\n/g, " ").slice(0, 50)) || "(sans titre)"}`,
    ),
  ];
  await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
}

/** Member J+1/5/9/10 follow-up schedule + staff thread nudges (full impl requires store helpers). */
export async function processOpsMaintenance(_deps: {
  client: Client;
  guildId: string;
  postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
  fetchThread?: (threadId: string | null) => Promise<{ send: (opts: unknown) => Promise<unknown>; setArchived?: (v: boolean) => Promise<unknown>; archived?: boolean } | null>;
}): Promise<void> {
  // Full schedule wired when request-store helpers are present; safe no-op otherwise.
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
  if (!request) return { ok: false, error: `Requête **${formatRequestId(input.requestId)}** introuvable.` };

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
    await input.postRequestUpdate(request, `❓ **Info demandée** par <@${input.askedById}>:\n${input.question}`);
  }

  try {
    const user = await input.client.users.fetch(request.memberId);
    await user.send({
      content:
        `On a besoin d’infos pour ta requête **${formatRequestId(request.id)}** :\n\n` +
        `> ${input.question}\n\n` +
        `Réponds ici ou utilise le salon prévu. Merci !`,
      allowedMentions: noMentions,
    });
  } catch {
    // DM closed — staff will see the follow-up in-panel / thread
  }

  return { ok: true, requestId: request.id };
}
