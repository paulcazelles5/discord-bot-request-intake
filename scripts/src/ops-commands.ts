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
} from "./request-store.js";

const noMentions = { parse: [] as const };
const DAY_MS = 24 * 60 * 60 * 1000;

let groqStats = {
  calls: 0,
  successes: 0,
  failures: 0,
  lastCallAt: 0 as number,
  lastError: "" as string,
};

export function recordGroqCall(result: {
  ok: boolean;
  error?: string;
}): void {
  groqStats.calls += 1;
  if (result.ok) groqStats.successes += 1;
  else {
    groqStats.failures += 1;
    if (result.error) groqStats.lastError = result.error.slice(0, 200);
  }
  groqStats.lastCallAt = Date.now();
}

function ageLabel(ms: number): string {
  const d = Math.floor(ms / DAY_MS);
  if (d <= 0) return "<1d";
  return `${d}d`;
}

export async function handleFindCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  const query = args.join(" ").trim();
  if (!query) {
    await message.reply({
      content: "Usage: `!find REQ-42` or `!find keyword`",
      allowedMentions: noMentions,
    });
    return;
  }
  const id = parseRequestId(query);
  if (id) {
    const request = await findRequestById(options.guildId, id);
    if (!request) {
      await message.reply({
        content: `Request **${formatRequestId(id)}** not found.`,
        allowedMentions: noMentions,
      });
      return;
    }
    if (!options.isStaff && request.memberId !== message.author.id) {
      await message.reply({
        content: "You can only look up your own requests.",
        allowedMentions: noMentions,
      });
      return;
    }
    const thread =
      request.threadId
        ? ` · [thread](https://discord.com/channels/${options.guildId}/${request.threadId})`
        : "";
    await message.reply({
      content:
        `**${formatRequestId(request.id)}** · \`${request.status}\`${thread}\n` +
        `Member: <@${request.memberId}> (\`${request.memberId}\`)\n` +
        `${String(request.description || "(no description)").slice(0, 300)}`,
      allowedMentions: noMentions,
    });
    return;
  }

  const rows = await listRequests(options.guildId, {
    page: 1,
    pageSize: 15,
    sort: "newest",
    memberId: options.isStaff ? undefined : message.author.id,
  });
  const q = query.toLowerCase();
  const matches = rows.filter(
    (r) =>
      String(r.description || "").toLowerCase().includes(q) ||
      String(r.setupDetails || "").toLowerCase().includes(q) ||
      String(r.memberTag || "").toLowerCase().includes(q) ||
      String(r.memberId).includes(q),
  );
  if (!matches.length) {
    await message.reply({
      content: `No matches for \`${query}\`.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const lines = matches.map(
    (r) =>
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${String(r.description || "").replace(/\n/g, " ").slice(0, 60)}`,
  );
  await message.reply({
    content:
      `**Find results** (${matches.length})\n${lines.join("\n")}`.slice(0, 1900) +
      (options.isStaff ? "" : "\n_Members only see their own matches; staff see all._"),
    allowedMentions: noMentions,
  });
}

export async function handleStatsCommand(
  message: Message,
  options: { guildId: string },
): Promise<void> {
  const byStatus = await countRequestsByStatus(options.guildId);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const lines = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `• **${status}**: ${n}`);
  await message.reply({
    content: `**Request stats** · **${total}** total\n${lines.join("\n") || "_empty_"}`,
    allowedMentions: noMentions,
  });
}

export async function handleHealthcheckCommand(
  message: Message,
  options: {
    guildId: string;
    client: Client;
    startedAt: number;
    verifyStoreReady: () => Promise<void>;
  },
): Promise<void> {
  const uptimeMs = Date.now() - options.startedAt;
  const hours = Math.floor(uptimeMs / 3_600_000);
  const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);
  let dbOk = false;
  let dbMs = 0;
  let dbError = "";
  const t0 = Date.now();
  try {
    await options.verifyStoreReady();
    dbOk = true;
    dbMs = Date.now() - t0;
  } catch (err) {
    dbMs = Date.now() - t0;
    dbError = err instanceof Error ? err.message : String(err);
  }
  const byStatus = await countRequestsByStatus(options.guildId).catch(() => ({} as Record<string, number>));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const open =
    (byStatus["received"] ?? 0) +
    (byStatus["accepted"] ?? 0) +
    (byStatus["in_progress"] ?? 0) +
    (byStatus["needs_info"] ?? 0) +
    (byStatus["awaiting_member"] ?? 0) +
    (byStatus["waiting_on_member"] ?? 0);
  const needsInfo = byStatus["needs_info"] ?? 0;
  const awaiting = (byStatus["awaiting_member"] ?? 0) + (byStatus["waiting_on_member"] ?? 0);
  const topStatuses = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `  · ${s}: ${n}`)
    .join("\n");
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const ping = Math.round(options.client.ws.ping);
  const groqLine =
    groqStats.calls === 0
      ? "no calls this session"
      : `ok ${groqStats.successes}/${groqStats.calls}` +
        (groqStats.lastError ? ` · last error: ${groqStats.lastError}` : "");

  const lines = [
    "**Healthcheck**",
    `• Uptime: **${hours}h ${mins}m**`,
    `• Memory: **${rssMb} MB** RSS · heap **${heapMb} MB**`,
    `• Discord WS ping: **${ping} ms**`,
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
    "_Auto maintenance: member reminders D+1/5/9/10 + staff pings (hourly)._",
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
    await message.reply({ content: "You have no requests right now.", allowedMentions: noMentions });
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
      ? `\n  ⏳ Pending question: ${String(pending.question).slice(0, 80)}`
      : "";
    const desc = String(r.description ?? "").replace(/\n/g, " ").slice(0, 50);
    lines.push(
      `• **${formatRequestId(r.id)}** · \`${r.status}\` · ${ageDays}d` +
        `${threadPart}\n  ${desc || "_(no description)_"}${pendingPart}`,
    );
  }

  await message.reply({
    content: `**Your requests** (${rows.length})\n${lines.join("\n")}`.slice(0, 1900),
    allowedMentions: noMentions,
  });
}

export async function handleStatusCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  const query = args[0]?.trim();
  let request =
    query && parseRequestId(query)
      ? await findRequestById(options.guildId, parseRequestId(query)!)
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
        : "You have no requests. Usage: `!status` or `!status REQ-42`.",
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
  const events = await listRequestEvents(request.id).catch(() => []);
  const age = ageLabel(Date.now() - new Date(request.createdAt).getTime());
  const thread =
    request.threadId
      ? `[open thread](https://discord.com/channels/${options.guildId}/${request.threadId})`
      : "_no thread_";

  const lines = [
    `**${formatRequestId(request.id)}** · \`${request.status}\` · age ${age}`,
    `Member: <@${request.memberId}>`,
    `Assignee: ${request.assignedToId ? `<@${request.assignedToId}>` : "_unassigned_"}`,
    `Thread: ${thread}`,
    "",
    "**Description**",
    String(request.description || "_(empty)_").slice(0, 400),
    "",
    "**Setup details**",
    String(request.setupDetails || "_(empty)_").slice(0, 400),
    "",
    pending
      ? `**Pending question**\n> ${String(pending.question).slice(0, 300)}`
      : "**Pending question:** _none_",
    "",
    `**Recent events:** ${events.slice(-5).map((e) => e.eventType).join(", ") || "_none_"}`,
  ];

  await message.reply({ content: lines.join("\n").slice(0, 1900), allowedMentions: noMentions });
}

const MEMBER_NUDGE_STEPS = [
  { afterMs: 1 * DAY_MS, event: "member_nudge_d1", warn: false },
  { afterMs: 5 * DAY_MS, event: "member_nudge_d5", warn: false },
  { afterMs: 9 * DAY_MS, event: "member_nudge_d9", warn: true },
];

export type OpsMaintenanceDeps = {
  client: Client;
  guildId: string;
  botUserId: string;
};

async function hasEvent(requestId: number, eventType: string): Promise<boolean> {
  const events = await listRequestEvents(requestId).catch(() => []);
  return events.some((e) => e.eventType === eventType);
}

export async function processOpsMaintenance(deps: OpsMaintenanceDeps): Promise<void> {
  const open = await listRequests(deps.guildId, { page: 1, pageSize: 100, sort: "oldest" });
  const now = Date.now();

  for (const request of open) {
    const followup = await findPendingFollowupForRequest(request.id).catch(() => null);
    if (!followup) continue;

    const ageMs = now - new Date(followup.createdAt).getTime();

    if (ageMs >= 10 * DAY_MS) {
      if (!(await hasEvent(request.id, "request_expired"))) {
        await setFollowupStatus(followup.id, "expired");
        await updateRequest(request.id, {
          status: "expired",
          stage: "complete",
          closedAt: new Date(),
        });
        await recordRequestEvent({
          requestId: request.id,
          guildId: deps.guildId,
          actorId: deps.botUserId,
          eventType: "request_expired",
        });
        try {
          const user = await deps.client.users.fetch(request.memberId);
          await user.send({
            content:
              `**${formatRequestId(request.id)}** expired: no reply after 10 days.\n` +
              `Please submit a new request with \\!request if still needed.`,
            allowedMentions: noMentions,
          });
        } catch {
          /* DM closed */
        }
        if (request.threadId) {
          try {
            const ch = await deps.client.channels.fetch(request.threadId);
            if (ch && "send" in ch) {
              await (ch as { send: (x: object) => Promise<unknown> }).send({
                content: `⏳ ${formatRequestId(request.id)} **expired** (member did not reply within 10 days).`,
                allowedMentions: noMentions,
              });
            }
          } catch {
            /* ignore */
          }
        }
      }
      continue;
    }

    for (const step of MEMBER_NUDGE_STEPS) {
      if (ageMs < step.afterMs) continue;
      if (await hasEvent(request.id, step.event)) continue;
      let content =
        `Reminder for **${formatRequestId(request.id)}**: staff is still waiting for your reply.\n\n` +
        `> ${String(followup.question).slice(0, 300)}\n\n` +
        `Reply here or use \\!resume in the server.`;
      if (step.warn) {
        content +=
          `\n\n⚠️ **Warning**: without a reply by tomorrow, this request will be **automatically expired**.`;
      }
      try {
        const user = await deps.client.users.fetch(request.memberId);
        await user.send({ content, allowedMentions: noMentions });
        await recordRequestEvent({
          requestId: request.id,
          guildId: deps.guildId,
          actorId: deps.botUserId,
          eventType: step.event,
        });
        if (request.threadId) {
          try {
            const ch = await deps.client.channels.fetch(request.threadId);
            if (ch && "send" in ch) {
              const dayLabel = Math.round(step.afterMs / DAY_MS);
              await (ch as { send: (x: object) => Promise<unknown> }).send({
                content:
                  `🔔 Member reminder D+${dayLabel} sent for ${formatRequestId(request.id)}.` +
                  (step.warn ? " (expiry warning D+10)" : ""),
                allowedMentions: noMentions,
              });
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* DM closed */
      }
      break;
    }
  }

  const openStatuses = new Set(["received", "accepted", "in_progress", "needs_info"]);
  for (const request of open) {
    if (!openStatuses.has(request.status)) continue;
    if (!request.threadId) continue;
    const idleMs = now - new Date(request.lastActivityAt).getTime();
    if (idleMs < 2 * DAY_MS) continue;
    if (await hasEvent(request.id, "staff_thread_nudge")) continue;
    try {
      const ch = await deps.client.channels.fetch(request.threadId);
      if (ch && "send" in ch) {
        await (ch as { send: (x: object) => Promise<unknown> }).send({
          content: `📢 Staff ping: **${formatRequestId(request.id)}** idle for ${Math.floor(idleMs / DAY_MS)} day(s).`,
          allowedMentions: noMentions,
        });
        await recordRequestEvent({
          requestId: request.id,
          guildId: deps.guildId,
          actorId: deps.botUserId,
          eventType: "staff_thread_nudge",
        });
      }
    } catch {
      /* ignore */
    }
  }
}

export async function handleAddThreadCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  if (!options.isStaff) {
    await message.reply({
      content: "Only staff can add a member to a request thread.",
      allowedMentions: noMentions,
    });
    return;
  }

  const mention = message.mentions.users.first();
  const idArg = args.find((a) => parseRequestId(a));
  const requestId = idArg ? parseRequestId(idArg) : null;
  const targetUserId = mention?.id;

  if (!targetUserId) {
    await message.reply({
      content: "Specify the member to add: `!addthread REQ-42 @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let threadId: string | null = null;
  let requestLabel = "this request";

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
        content: `**${formatRequestId(requestId)}** has no thread yet.`,
        allowedMentions: noMentions,
      });
      return;
    }
    threadId = request.threadId;
    requestLabel = formatRequestId(requestId);
  } else if (message.channel.isThread()) {
    threadId = message.channel.id;
  } else {
    await message.reply({
      content:
        "Specify the request: `!addthread REQ-42 @user`\n" +
        "Or run the command **inside** the request thread: `!addthread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
    const channel = await message.client.channels.fetch(threadId!);
    if (!channel || !channel.isThread()) {
      await message.reply({
        content: `Could not find the thread for ${requestLabel}.`,
        allowedMentions: noMentions,
      });
      return;
    }
    await channel.members.add(targetUserId);
    if (requestId) {
      await recordRequestEvent({
        requestId,
        guildId: options.guildId,
        actorId: message.author.id,
        eventType: "thread_member_added",
        details: `user=${targetUserId};thread=${threadId}`,
      }).catch(() => undefined);
    }
    await message.reply({
      content: `✅ <@${targetUserId}> added to the thread for **${requestLabel}**.`,
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
        `Make sure the bot has **Manage Threads**.\n` +
        `\`${msg.slice(0, 200)}\``,
      allowedMentions: noMentions,
    });
  }
}

export async function handleRemoveThreadCommand(
  message: Message,
  args: string[],
  options: { guildId: string; isStaff: boolean },
): Promise<void> {
  if (!options.isStaff) {
    await message.reply({
      content: "Only staff can remove a member from a request thread.",
      allowedMentions: noMentions,
    });
    return;
  }

  const mention = message.mentions.users.first();
  const idArg = args.find((a) => parseRequestId(a));
  const requestId = idArg ? parseRequestId(idArg) : null;
  const targetUserId = mention?.id;

  if (!targetUserId) {
    await message.reply({
      content: "Specify the member to remove: `!removethread REQ-42 @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  let threadId: string | null = null;
  let requestLabel = "this request";

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
        content: `**${formatRequestId(requestId)}** has no thread.`,
        allowedMentions: noMentions,
      });
      return;
    }
    threadId = request.threadId;
    requestLabel = formatRequestId(requestId);
  } else if (message.channel.isThread()) {
    threadId = message.channel.id;
  } else {
    await message.reply({
      content:
        "Specify the request: `!removethread REQ-42 @user`\n" +
        "Or run the command **inside** the thread: `!removethread @user`",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
    const channel = await message.client.channels.fetch(threadId!);
    if (!channel || !channel.isThread()) {
      await message.reply({
        content: `Could not find the thread for ${requestLabel}.`,
        allowedMentions: noMentions,
      });
      return;
    }
    await channel.members.remove(targetUserId);
    if (requestId) {
      await recordRequestEvent({
        requestId,
        guildId: options.guildId,
        actorId: message.author.id,
        eventType: "thread_member_removed",
        details: `user=${targetUserId};thread=${threadId}`,
      }).catch(() => undefined);
    }
    await message.reply({
      content: `✅ <@${targetUserId}> removed from the thread for **${requestLabel}**.`,
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
        `Make sure the bot has **Manage Threads**.\n` +
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
  await updateRequest(request.id, {
    status: "needs_info",
    lastActivityAt: new Date(),
  });
  await recordRequestEvent({
    requestId: request.id,
    guildId: input.guildId,
    actorId: input.askedById,
    eventType: "info_requested",
    details: input.question.slice(0, 200),
  }).catch(() => undefined);

  if (input.postRequestUpdate) {
    await input.postRequestUpdate(request, `Staff asked for more info: ${input.question.slice(0, 200)}`);
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
