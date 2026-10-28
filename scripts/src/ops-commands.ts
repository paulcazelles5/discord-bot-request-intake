import {
  type Client,
  type Message,
} from "discord.js";
import {
  countRequestsByStatus,
  createFollowup,
  findRequestById,
  formatRequestId,
  listRequests,
  parseRequestId,
  recordRequestEvent,
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
  latencyMs?: number;
  error?: string;
  tokensApprox?: number;
}): void {
  groqStats.calls += 1;
  if (result.ok) groqStats.successes += 1;
  else {
    groqStats.failures += 1;
    groqStats.lastError = result.error ?? "unknown";
  }
  groqStats.lastCallAt = Date.now();
  if (typeof result.latencyMs === "number") groqStats.lastLatencyMs = result.latencyMs;
  if (typeof result.tokensApprox === "number") groqStats.totalTokensApprox += result.tokensApprox;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
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
        "Usage: `!find REQ-ID | @user | keyword`\n" +
        "Members only see their own matches; staff see all.",
      allowedMentions: noMentions,
    });
    return;
  }

  const asId = parseRequestId(query);
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
      `Member: <@${request.memberId}>`,
      request.assigneeId ? `Assignee: <@${request.assigneeId}>` : null,
      `Created: ${new Date(request.createdAt).toISOString()}`,
      request.description ? `Description: ${String(request.description).slice(0, 400)}` : null,
    ].filter(Boolean);
    await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
    return;
  }

  const mention = message.mentions.users.first();
  const memberId = mention?.id;
  if (memberId && !options.isStaff && memberId !== message.author.id) {
    await message.reply({ content: "You can only look up your own requests.", allowedMentions: noMentions });
    return;
  }

  const rows = await listRequests(options.guildId, {
    memberId: options.isStaff ? memberId : message.author.id,
    limit: 15,
    offset: 0,
    sort: "newest",
  });

  const q = query.toLowerCase();
  const filtered = memberId
    ? rows
    : rows.filter((r) => {
        const blob = `${r.id} ${r.status} ${r.stage} ${r.description ?? ""} ${r.memberId}`.toLowerCase();
        return blob.includes(q);
      });

  if (!filtered.length) {
    await message.reply({ content: "No matching requests.", allowedMentions: noMentions });
    return;
  }

  const lines = filtered.map(
    (r) =>
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · <@${r.memberId}> · ${String(r.description ?? "").replace(/\n/g, " ").slice(0, 60)}`,
  );
  await message.reply({
    content: `**Matches** (${filtered.length})\n${lines.join("\n")}`.slice(0, 1900),
    allowedMentions: noMentions,
  });
}

export async function handleStatsCommand(
  message: Message,
  options: { guildId: string },
): Promise<void> {
  const counts = await countRequestsByStatus(options.guildId);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `• \`${status}\`: **${n}**`);
  const groqLine =
    groqStats.calls > 0
      ? `Groq: ${groqStats.successes}/${groqStats.calls} ok` +
        (groqStats.lastLatencyMs != null ? ` · last ${groqStats.lastLatencyMs}ms` : "") +
        (groqStats.lastError ? ` · last error: ${groqStats.lastError.slice(0, 80)}` : "")
      : "Groq: no calls this session";
  await message.reply({
    content: [
      "**Request stats**",
      `Total tracked: **${total}**`,
      ...lines,
      groqLine,
    ].join("\n").slice(0, 1900),
    allowedMentions: noMentions,
  });
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
    limit: 25,
    offset: 0,
    sort: "newest",
  });
  if (!rows.length) {
    await message.reply({
      content: "You have no requests.",
      allowedMentions: noMentions,
    });
    return;
  }
  const lines = rows.map(
    (r) =>
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${new Date(r.createdAt).toISOString().slice(0, 10)} · ${(String(r.description ?? "").replace(/\n/g, " ").slice(0, 50)) || "(no title)"}`,
  );
  await message.reply({
    content: [
      `**Your requests** (${rows.length}${rows.length >= 25 ? "+" : ""})`,
      ...lines,
    ].join("\n").slice(0, 1900),
    allowedMentions: noMentions,
  });
}

/** Member follow-up schedule + staff thread nudges (extended when store helpers present). */
export async function processOpsMaintenance(_deps: {
  client: Client;
  guildId: string;
  postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
  fetchThread?: (threadId: string | null) => Promise<unknown>;
}): Promise<void> {
  // Safe no-op until advanced store helpers are deployed.
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
