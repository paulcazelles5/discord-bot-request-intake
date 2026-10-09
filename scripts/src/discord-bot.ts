import {
  AttachmentBuilder,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import {
  addRequestAttachment,
  answerFollowup,
  countRecentRequests,
  createFollowup,
  createRequest,
  deleteRetainedRequests,
  findActiveRequestForMember,
  findPendingFollowupForMember,
  findPendingFollowupForRequest,
  findPendingMemberFlowForMember,
  findRequestById,
  formatRequestId,
  getBotSettings,
  grantOwnerAccess,
  grantCommandPermission,
  hasOwnerAccess,
  isCommandAllowed,
  listAllRequestData,
  listAllRequestsForBackup,
  listCommandPermissions,
  listRequestsForMaintenance,
  listRequests,
  parseRequestId,
  recordRequestEvent,
  revokeCommandPermission,
  setBotSettings,
  setFollowupStatus,
  updateRequest,
  verifyStoreReady,
  type RequestStatus,
} from "./request-store.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const HOME_GUILD_ID = "1499704751481294878";
const OWNER_ID = "1264183250243420211";
const REQUESTS_CHANNEL_NAME = "・requests";
const DATA_CHANNEL_NAME = "・data";
const MAX_REPLY_LENGTH = 1_200;
const MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_IMAGES = 3;
const REQUEST_LIMIT_PER_DAY = 3;
const MEMBER_REMINDER_AFTER_MS = 48 * 60 * 60 * 1_000;
const MEMBER_EXPIRY_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1_000;
const STAFF_COMMANDS = [
  "!history",
  "!log",
  "!ask",
  "!status",
  "!assign",
  "!reopen",
  "!export",
  "!backup",
  "!retention",
] as const;
const PUBLIC_STATUS_ALIASES: Record<string, RequestStatus> = {
  received: "received",
  accepted: "accepted",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  completed: "completed",
  declined: "declined",
};
const TERMINAL_STATUSES = new Set<RequestStatus>([
  "completed",
  "declined",
  "cancelled",
  "expired",
]);
const noMentions = { parse: [] as const };

if (!BOT_TOKEN) {
  throw new Error("Missing required DISCORD_BOT_TOKEN secret.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

function redactLikelyCredentials(value: string): string {
  return value
    .replace(/\bmfa\.[A-Za-z\d_-]{20,}\b/gi, "[REDACTED CREDENTIAL]")
    .replace(
      /\b[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{5,}\.[A-Za-z\d_-]{20,}\b/g,
      "[REDACTED CREDENTIAL]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED CREDENTIAL]")
    .replace(
      /\b(bot[_ -]?token|token|client[_ -]?secret|api[_ -]?key|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1: [REDACTED CREDENTIAL]",
    );
}

function containsLikelyCredential(value: string): boolean {
  return redactLikelyCredentials(value) !== value;
}

function capForDiscord(value: string): string {
  if (value.length <= 1_850) return value;
  return `${value.slice(0, 1_780)}\n\n[Message shortened to fit Discord's limit.]`;
}

function formatStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function requestLink(request: {
  guildId: string;
  requestChannelId: string | null;
  requestMessageId: string | null;
}): string {
  if (!request.requestChannelId || !request.requestMessageId) return "not posted yet";
  return `https://discord.com/channels/${request.guildId}/${request.requestChannelId}/${request.requestMessageId}`;
}

function parseUserId(value: string | undefined): string | null {
  if (!value) return null;
  const mention = value.match(/^<@!?(\d{17,20})>$/);
  const raw = value.match(/^(\d{17,20})$/);
  return mention?.[1] ?? raw?.[1] ?? null;
}

async function findStaffChannel(name: string): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(
    (candidate) =>
      candidate?.type === ChannelType.GuildText && candidate.name === name,
  );
  return channel?.type === ChannelType.GuildText ? channel : null;
}

async function fetchGuildTextChannel(channelId: string): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  const channel = await guild.channels.fetch(channelId);
  return channel?.type === ChannelType.GuildText ? channel : null;
}

async function fetchThread(threadId: string | null): Promise<ThreadChannel | null> {
  if (!threadId) return null;
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  const channel = await guild.channels.fetch(threadId);
  return channel?.isThread() ? channel : null;
}

async function sendLongDm(userId: string, content: string): Promise<void> {
  const user = await client.users.fetch(userId);
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 1_850) {
    let splitAt = remaining.lastIndexOf("\n", 1_850);
    if (splitAt < 700) splitAt = 1_850;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  for (const chunk of chunks) {
    await user.send({ content: chunk, allowedMentions: noMentions });
  }
}

async function sendRequestLog(message: Message): Promise<void> {
  try {
    const settings = await getBotSettings(HOME_GUILD_ID);
    if (!settings?.logChannelId) return;
    const channel = await fetchGuildTextChannel(settings.logChannelId);
    if (!channel) throw new Error("Configured log channel is not a text channel.");
    const timestamp = Math.floor(message.createdTimestamp / 1_000);
    const displayName = message.member?.displayName ?? message.author.username;
    await channel.send({
      content:
        `**New bot request started**\n` +
        `Member: ${displayName} (<@${message.author.id}> / \`${message.author.id}\`)\n` +
        `Time: <t:${timestamp}:F>\n` +
        `Command channel: <#${message.channelId}>`,
      allowedMentions: noMentions,
    });
  } catch {
    console.error("Could not post request activity to the configured log channel.");
  }
}

async function isAuthorized(
  message: Message,
  command: (typeof STAFF_COMMANDS)[number],
): Promise<boolean> {
  if (await hasOwnerCommandAccess(message.author.id)) return true;
  if (await isCommandAllowed(HOME_GUILD_ID, message.author.id, command)) return true;
  await message.reply({
    content:
      `You don’t have permission to use \`${command}\`. An owner can grant it with ` +
      `\`!perm ${command} ${message.author.id}\`.`,
    allowedMentions: noMentions,
  });
  return false;
}

async function hasOwnerCommandAccess(userId: string): Promise<boolean> {
  return userId === OWNER_ID || hasOwnerAccess(HOME_GUILD_ID, userId);
}

async function findRequestImages(message: Message): Promise<
  Array<{
    url: string;
    fileName: string;
    contentType: string;
    byteSize: number;
  }>
> {
  const attachments = [...message.attachments.values()];
  if (attachments.length > MAX_REQUEST_IMAGES) {
    throw new Error(`Please attach no more than ${MAX_REQUEST_IMAGES} reference images.`);
  }
  const images = attachments.map((attachment) => {
    const contentType = attachment.contentType?.split(";")[0]?.toLowerCase();
    if (
      !contentType ||
      !["image/png", "image/jpeg", "image/webp"].includes(contentType)
    ) {
      throw new Error("Only PNG, JPG, and WebP reference images are accepted.");
    }
    if (attachment.size > MAX_REQUEST_IMAGE_BYTES) {
      throw new Error("Each reference image must be 8 MB or smaller.");
    }
    const fileName = (attachment.name ?? "reference-image")
      .replace(/[^\w.-]/g, "_")
      .slice(0, 80);
    return {
      url: attachment.url,
      fileName: fileName || "reference-image",
      contentType,
      byteSize: attachment.size,
    };
  });
  return images;
}

function matchesImageSignature(buffer: Buffer, contentType: string): boolean {
  if (contentType === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === "image/webp") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

async function deliverRequestImages(
  request: Awaited<ReturnType<typeof findActiveRequestForMember>> & {},
  images: Awaited<ReturnType<typeof findRequestImages>>,
  destination: TextChannel | ThreadChannel,
): Promise<void> {
  if (images.length === 0) return;
  const downloaded: Array<{ buffer: Buffer; fileName: string; contentType: string; byteSize: number }> =
    [];
  for (const image of images) {
    const response = await fetch(image.url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error("A reference image could not be downloaded.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (
      buffer.length > MAX_REQUEST_IMAGE_BYTES ||
      !matchesImageSignature(buffer, image.contentType)
    ) {
      throw new Error("A reference image could not be verified as a supported image.");
    }
    downloaded.push({ ...image, buffer });
  }

  const sent = await destination.send({
    content:
      `Reference image${downloaded.length === 1 ? "" : "s"} for ${formatRequestId(request.id)}. ` +
      "Images are forwarded for visual reference only; never upload credentials or screenshots containing secrets.",
    files: downloaded.map((image) => ({
      attachment: image.buffer,
      name: image.fileName,
    })),
    allowedMentions: noMentions,
  });
  for (const image of downloaded) {
    await addRequestAttachment({
      requestId: request.id,
      fileName: image.fileName,
      contentType: image.contentType,
      byteSize: image.byteSize,
      threadMessageId: sent.id,
    });
  }
}

async function publishInitialRequest(
  request: NonNullable<Awaited<ReturnType<typeof findActiveRequestForMember>>>,
  authorId: string,
  authorName: string,
  images: Awaited<ReturnType<typeof findRequestImages>> = [],
): Promise<NonNullable<Awaited<ReturnType<typeof findActiveRequestForMember>>>> {
  const existingChannel = request.requestChannelId
    ? await fetchGuildTextChannel(request.requestChannelId)
    : null;
  const requestsChannel =
    existingChannel ?? (await findStaffChannel(REQUESTS_CHANNEL_NAME));
  if (!requestsChannel) throw new Error("The requests channel is unavailable.");

  let sentRequest: Message;
  if (request.requestMessageId && requestsChannel.messages) {
    try {
      sentRequest = await requestsChannel.messages.fetch(request.requestMessageId);
    } catch {
      sentRequest = await requestsChannel.send({
        content: capForDiscord(
          `**${formatRequestId(request.id)} | New bot request**\n` +
            `Requested by: <@${authorId}> (\`${authorId}\`)\n\n${request.description}`,
        ),
        allowedMentions: noMentions,
      });
    }
  } else {
    sentRequest = await requestsChannel.send({
      content: capForDiscord(
        `**${formatRequestId(request.id)} | New bot request**\n` +
          `Requested by: <@${authorId}> (\`${authorId}\`)\n\n${request.description}`,
      ),
      allowedMentions: noMentions,
    });
  }

  let updated = await updateRequest(request.id, {
    requestChannelId: requestsChannel.id,
    requestMessageId: sentRequest.id,
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  let thread = await fetchThread(updated.threadId);
  if (!thread) {
    try {
      thread = await sentRequest.startThread({
        name: `${formatRequestId(request.id)} — ${authorName}`.slice(0, 100),
        autoArchiveDuration: 10_080,
        reason: `Staff discussion for ${formatRequestId(request.id)}`,
      });
      updated = await updateRequest(request.id, { threadId: thread.id });
      await thread.send({
        content:
          `Staff discussion for ${formatRequestId(request.id)}.\n` +
          `Requester: <@${authorId}> (\`${authorId}\`)\nStatus: awaiting member setup details.`,
        allowedMentions: noMentions,
      });
    } catch {
      await recordRequestEvent({
        requestId: request.id,
        guildId: HOME_GUILD_ID,
        actorId: client.user?.id ?? OWNER_ID,
        eventType: "thread_creation_failed",
      });
      console.error(
        `Could not create the request thread for ${formatRequestId(request.id)}; check Create Public Threads and Send Messages in Threads.`,
      );
    }
  }

  if (images.length > 0) {
    try {
      await deliverRequestImages(updated, images, thread ?? requestsChannel);
    } catch {
      await recordRequestEvent({
        requestId: request.id,
        guildId: HOME_GUILD_ID,
        actorId: client.user?.id ?? OWNER_ID,
        eventType: "reference_image_delivery_failed",
      });
      throw new Error("The request text was saved, but a reference image could not be delivered.");
    }
  }

  return updated;
}

async function sendSetupPrompt(userId: string, requestId: number): Promise<void> {
  const user = await client.users.fetch(userId);
  await user.send({
    content:
      `Thanks — your request ${formatRequestId(requestId)} is in \`・requests\`.\n\n` +
      "Now send any **non-secret** setup details that may help: application/client ID, required permissions or intents, " +
      "preferred language/library, and hosting needs. Do not send a bot token, OAuth client secret, password, API key, " +
      "or other credential. You will add credentials yourself in your hosting provider’s private secrets.",
    allowedMentions: noMentions,
  });
}

async function publishSetupDetails(
  request: NonNullable<Awaited<ReturnType<typeof findActiveRequestForMember>>>,
): Promise<void> {
  const dataChannel = await findStaffChannel(DATA_CHANNEL_NAME);
  if (!dataChannel) throw new Error("The data channel is unavailable.");
  await dataChannel.send({
    content: capForDiscord(
      `**Non-secret setup details — ${formatRequestId(request.id)}**\n` +
        `Requested by: <@${request.memberId}> (\`${request.memberId}\`)\n` +
        `Request: ${requestLink(request)}\n\n${request.setupDetails}`,
    ),
    allowedMentions: noMentions,
  });

  const updated = await updateRequest(request.id, {
    stage: "complete",
    status: "received",
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: request.memberId,
    eventType: "setup_details_received",
  });
  try {
    await postRequestUpdate(
      updated,
      `Setup details received from <@${request.memberId}>. Status: received.`,
    );
  } catch {
    console.error(`Could not post the setup-details update for ${formatRequestId(request.id)}.`);
  }
  try {
    const user = await client.users.fetch(request.memberId);
    await user.send({
      content:
        `Your non-secret setup details for ${formatRequestId(request.id)} have been sent to the staff team in \`・data\`.`,
      allowedMentions: noMentions,
    });
  } catch {
    console.error(`Could not confirm setup delivery to the requester for ${formatRequestId(request.id)}.`);
  }
}

async function startRequest(message: Message): Promise<void> {
  if (!message.guild || message.guild.id !== HOME_GUILD_ID) return;
  await sendRequestLog(message);

  const pending = await findPendingMemberFlowForMember(HOME_GUILD_ID, message.author.id);
  if (pending) {
    await message.reply({
      content:
        `You already have a request waiting for your reply (${formatRequestId(pending.id)}). ` +
        "Continue in your DMs, or use `!resume` if you need the current question again.",
      allowedMentions: noMentions,
    });
    return;
  }
  const active = await findActiveRequestForMember(HOME_GUILD_ID, message.author.id);
  if (active) {
    await message.reply({
      content:
        `You already have an open request (${formatRequestId(active.id)}, status: ${formatStatus(active.status)}). ` +
        "Please wait for the staff team, or use `!cancel` before opening another request.",
      allowedMentions: noMentions,
    });
    return;
  }

  const requestsToday = await countRecentRequests(
    HOME_GUILD_ID,
    message.author.id,
    new Date(Date.now() - 24 * 60 * 60 * 1_000),
  );
  if (requestsToday >= REQUEST_LIMIT_PER_DAY) {
    await message.reply({
      content: `You can start up to ${REQUEST_LIMIT_PER_DAY} requests per 24 hours. Please try again later.`,
      allowedMentions: noMentions,
    });
    return;
  }

  const request = await createRequest({
    guildId: HOME_GUILD_ID,
    memberId: message.author.id,
    memberTag: message.author.tag,
  });
  try {
    await message.author.send({
      content:
        `Please describe the bot you’d like the staff team to build for you (request ${formatRequestId(request.id)}).\n` +
        "Include its purpose, who will use it, its main features, and an example of how it should work.\n\n" +
        "You may attach up to three PNG, JPG, or WebP reference images. Images are shared with staff; do not upload " +
        "screenshots containing tokens, passwords, client secrets, or other credentials. Never send credentials in Discord. " +
        "You will add any required secrets yourself in your hosting provider’s private secrets.",
      allowedMentions: noMentions,
    });
    await message.reply({
      content:
        `I sent you a DM to collect request ${formatRequestId(request.id)}. Check your message requests if you don’t see it.`,
      allowedMentions: noMentions,
    });
  } catch {
    await updateRequest(request.id, {
      status: "cancelled",
      stage: "complete",
      closedAt: new Date(),
    });
    await recordRequestEvent({
      requestId: request.id,
      guildId: HOME_GUILD_ID,
      actorId: message.author.id,
      eventType: "request_cancelled_dm_unavailable",
    });
    await message.reply({
      content:
        "I couldn’t DM you. Enable direct messages from this server, then try `!request` again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleRequestDetails(message: Message): Promise<void> {
  const request = await findPendingMemberFlowForMember(HOME_GUILD_ID, message.author.id);
  if (!request || request.stage !== "request") return;
  const submittedText = message.content.trim();
  if (!submittedText) {
    await message.reply("Please include a text description of the bot you want built.");
    return;
  }
  if (submittedText.length > MAX_REPLY_LENGTH) {
    await message.reply(
      `Please shorten your message to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    );
    return;
  }
  if (containsLikelyCredential(submittedText)) {
    await message.reply(
      "That message appears to contain a credential, so I did not forward or save it. Delete it from this DM and resend the request without any token, password, API key, client secret, or other credential.",
    );
    return;
  }

  let images: Awaited<ReturnType<typeof findRequestImages>>;
  try {
    images = await findRequestImages(message);
  } catch (error) {
    await message.reply(
      error instanceof Error ? error.message : "I couldn’t accept those attachments.",
    );
    return;
  }

  const saved = await updateRequest(request.id, {
    description: redactLikelyCredentials(submittedText),
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  try {
    const published = await publishInitialRequest(
      saved,
      message.author.id,
      message.author.username,
      images,
    );
    const movedToSetup = await updateRequest(published.id, {
      stage: "setup",
      status: "awaiting_member",
      lastActivityAt: new Date(),
      reminderSentAt: null,
    });
    await recordRequestEvent({
      requestId: movedToSetup.id,
      guildId: HOME_GUILD_ID,
      actorId: message.author.id,
      eventType: "request_submitted",
    });
    await sendSetupPrompt(message.author.id, movedToSetup.id);
  } catch {
    await message.reply(
      `I saved your request ${formatRequestId(request.id)}, but couldn’t finish posting it. Use \`!resume\` in the server to retry. Do not resend credentials.`,
    );
  }
}

async function handleSetupDetails(message: Message): Promise<void> {
  const request = await findPendingMemberFlowForMember(HOME_GUILD_ID, message.author.id);
  if (!request || request.stage !== "setup") return;
  if (message.attachments.size > 0) {
    await message.reply(
      "Please send setup details as text only. Do not send files that could contain tokens, passwords, API keys, or client secrets.",
    );
    return;
  }

  const submittedText = message.content.trim();
  if (!submittedText && !request.setupDetails) {
    await message.reply("Please send your non-secret setup details as a text message.");
    return;
  }
  if (submittedText.length > MAX_REPLY_LENGTH) {
    await message.reply(
      `Please shorten your message to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    );
    return;
  }
  if (submittedText && containsLikelyCredential(submittedText)) {
    await message.reply(
      "That message appears to contain a credential, so I did not forward or save it. Delete it from this DM and resend only non-secret setup details.",
    );
    return;
  }

  const saved = submittedText
    ? await updateRequest(request.id, {
        setupDetails: redactLikelyCredentials(submittedText),
        lastActivityAt: new Date(),
        reminderSentAt: null,
      })
    : request;
  try {
    await publishSetupDetails(saved);
  } catch {
    await message.reply(
      `I couldn’t deliver your setup details to \`・data\`. They are saved with ${formatRequestId(request.id)}; use \`!resume\` in the server to retry.`,
    );
  }
}

async function handleFollowupReply(message: Message): Promise<void> {
  const pending = await findPendingFollowupForMember(HOME_GUILD_ID, message.author.id);
  if (!pending) return;
  const answer = message.content.trim();
  if (!answer) {
    await message.reply("Please send your answer as a text message.");
    return;
  }
  if (message.attachments.size > 0) {
    await message.reply("Please send your follow-up answer as text only.");
    return;
  }
  if (answer.length > MAX_REPLY_LENGTH) {
    await message.reply(
      `Please shorten your answer to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer.`,
    );
    return;
  }
  if (containsLikelyCredential(answer)) {
    await message.reply(
      "That message appears to contain a credential, so I did not forward it. Delete it and resend only non-secret information.",
    );
    return;
  }

  const safeAnswer = redactLikelyCredentials(answer);
  const dataChannel = await findStaffChannel(DATA_CHANNEL_NAME);
  if (!dataChannel) {
    await message.reply(
      "I couldn’t deliver your reply to the staff channel. Your follow-up is still open; please try again later.",
    );
    return;
  }

  await dataChannel.send({
    content: capForDiscord(
      `**Staff follow-up reply — ${formatRequestId(pending.request.id)}**\n` +
        `Member: <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `Asked by: <@${pending.followup.askedById}>\n` +
        `Question: ${pending.followup.question}\n\nAnswer:\n${safeAnswer}`,
    ),
    allowedMentions: noMentions,
  });
  await answerFollowup(pending.followup.id, safeAnswer);
  const nextStatus = pending.request.assignedToId ? "in_progress" : "received";
  const updated = await updateRequest(pending.request.id, {
    status: nextStatus,
    stage: "complete",
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  await recordRequestEvent({
    requestId: updated.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "followup_answered",
  });
  await postRequestUpdate(
    updated,
    `Follow-up answered by <@${message.author.id}>. Status: ${formatStatus(nextStatus)}.`,
  );
  await message.reply("Thanks — I sent your reply to the staff team.");
}

async function sendResumePrompt(
  userId: string,
  request: NonNullable<Awaited<ReturnType<typeof findPendingMemberFlowForMember>>>,
): Promise<void> {
  if (request.stage === "request") {
    if (request.description) {
      const published = request.requestMessageId
        ? request
        : await publishInitialRequest(request, userId, "member");
      const updated = await updateRequest(published.id, {
        stage: "setup",
        status: "awaiting_member",
        lastActivityAt: new Date(),
        reminderSentAt: null,
      });
      await sendSetupPrompt(userId, updated.id);
      return;
    }
    const user = await client.users.fetch(userId);
    await user.send({
      content:
        `Please describe the bot you want the staff team to build (${formatRequestId(request.id)}): its purpose, ` +
        "who will use it, and its main features. Do not send credentials.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (request.stage === "setup") {
    if (request.setupDetails) {
      await publishSetupDetails(request);
      return;
    }
    await sendSetupPrompt(userId, request.id);
    return;
  }
  const pendingFollowup = await findPendingFollowupForRequest(request.id);
  if (pendingFollowup) {
    const user = await client.users.fetch(userId);
    await user.send({
      content:
        `The staff team has a follow-up question about ${formatRequestId(request.id)}:\n\n` +
        `${pendingFollowup.question}\n\nReply here with non-secret information only.`,
      allowedMentions: noMentions,
    });
  }
}

async function handleResumeCommand(message: Message): Promise<void> {
  const request = await findPendingMemberFlowForMember(HOME_GUILD_ID, message.author.id);
  if (!request) {
    const active = await findActiveRequestForMember(HOME_GUILD_ID, message.author.id);
    await message.reply({
      content: active
        ? `Your request ${formatRequestId(active.id)} is with the staff team (status: ${formatStatus(active.status)}). There is no unanswered DM step to resume.`
        : "You don’t have an open request to resume. Use `!request` to start one.",
      allowedMentions: noMentions,
    });
    return;
  }
  try {
    await sendResumePrompt(message.author.id, request);
    await message.reply({
      content: `I sent the current step for ${formatRequestId(request.id)} to your DMs.`,
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t DM you. Enable direct messages from this server, then try `!resume` again.",
      allowedMentions: noMentions,
    });
  }
}

async function postRequestUpdate(
  request: NonNullable<Awaited<ReturnType<typeof findActiveRequestForMember>>>,
  content: string,
): Promise<void> {
  const thread = await fetchThread(request.threadId);
  if (thread) {
    try {
      if (thread.archived) await thread.setArchived(false);
      await thread.send({ content: capForDiscord(content), allowedMentions: noMentions });
      return;
    } catch {
      // A missing thread permission should not prevent the status change itself.
    }
  }
  const channel = request.requestChannelId
    ? await fetchGuildTextChannel(request.requestChannelId)
    : await findStaffChannel(REQUESTS_CHANNEL_NAME);
  if (channel) {
    await channel.send({
      content: capForDiscord(`**${formatRequestId(request.id)} update**\n${content}`),
      allowedMentions: noMentions,
    });
  }
}

async function notifyMember(
  request: NonNullable<Awaited<ReturnType<typeof findActiveRequestForMember>>>,
  content: string,
): Promise<void> {
  try {
    const user = await client.users.fetch(request.memberId);
    await user.send({ content: capForDiscord(content), allowedMentions: noMentions });
  } catch {
    console.error(`Could not DM the requester for ${formatRequestId(request.id)}.`);
  }
}

async function handleHistoryCommand(message: Message, args: string[]): Promise<void> {
  const page = args[1] ? Number(args[1]) : 1;
  if (!Number.isInteger(page) || page < 1 || page > 1_000) {
    await message.reply({
      content: "Usage: `!history [page] [status] [user-id]` — pages show 20 requests.",
      allowedMentions: noMentions,
    });
    return;
  }
  const filters: Parameters<typeof listRequests>[1] = { page, pageSize: 20 };
  if (args[2]) {
    const status = args[2].toLowerCase().replaceAll("-", "_") as RequestStatus;
    const knownStatuses: RequestStatus[] = [
      "awaiting_member",
      "waiting_on_member",
      "received",
      "needs_info",
      "accepted",
      "in_progress",
      "completed",
      "declined",
      "cancelled",
      "expired",
    ];
    if (knownStatuses.includes(status)) filters.status = status;
    else if (/^\d{17,20}$/.test(args[2])) filters.memberId = args[2];
    else {
      await message.reply({
        content: "Use a request status or a member ID as the optional history filter.",
        allowedMentions: noMentions,
      });
      return;
    }
  }
  if (args[3]) {
    if (!/^\d{17,20}$/.test(args[3])) {
      await message.reply({
        content: "The optional member ID must be a Discord user ID.",
        allowedMentions: noMentions,
      });
      return;
    }
    filters.memberId = args[3];
  }
  const requests = await listRequests(HOME_GUILD_ID, filters);
  const header = `**Bot requests — page ${page} (20 per page)**`;
  const lines = requests.map(
    (request) =>
      `• **${formatRequestId(request.id)}** ` +
      (request.requestMessageId ? `[open](${requestLink(request)}) · ` : "") +
      `${formatStatus(request.status)} · <@${request.memberId}> · ` +
      `<t:${Math.floor(request.createdAt.getTime() / 1_000)}:f>` +
      (request.assignedToId ? ` · assigned <@${request.assignedToId}>` : ""),
  );
  try {
    await sendLongDm(
      message.author.id,
      `${header}\n${lines.length ? lines.join("\n") : "No requests match those filters."}`,
    );
    await message.reply({
      content: "I sent the request history to your DMs.",
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t DM you the history. Enable direct messages and try again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleLogCommand(message: Message, args: string[]): Promise<void> {
  const channelId = parseUserOrChannelId(args[1], true);
  if (!channelId || args.length !== 2) {
    await message.reply({
      content: "Usage: `!log #channel` — set the channel for metadata-only request activity logs.",
      allowedMentions: noMentions,
    });
    return;
  }
  const channel = await fetchGuildTextChannel(channelId);
  if (!channel || !message.guild) {
    await message.reply({
      content: "I couldn’t find that text channel in this server.",
      allowedMentions: noMentions,
    });
    return;
  }
  const botMember = message.guild.members.me ?? (await message.guild.members.fetchMe());
  const permissions = channel.permissionsFor(botMember);
  if (
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])
  ) {
    await message.reply({
      content: "I need View Channel and Send Messages permissions in that channel.",
      allowedMentions: noMentions,
    });
    return;
  }

  await setBotSettings(HOME_GUILD_ID, { logChannelId: channel.id });
  await recordRequestEvent({
    requestId: null,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "request_log_channel_changed",
  });
  await message.reply({
    content:
      `Request activity logging is enabled in <#${channel.id}>. Each \`!request\` log contains the member name, ` +
      "user ID, time, and command channel; it never copies the DM contents.",
    allowedMentions: noMentions,
  });
}

function parseUserOrChannelId(value: string | undefined, channel: boolean): string | null {
  if (!value) return null;
  if (channel) {
    const mention = value.match(/^<#(\d{17,20})>$/);
    const raw = value.match(/^(\d{17,20})$/);
    return mention?.[1] ?? raw?.[1] ?? null;
  }
  return parseUserId(value);
}

async function handleAskCommand(message: Message, args: string[]): Promise<void> {
  const targetId = parseUserId(args[1]);
  const question = args.slice(2).join(" ").trim();
  if (!targetId || !question) {
    await message.reply({
      content: "Usage: `!ask @user <question>` — send one non-secret follow-up question in DMs.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (question.length > MAX_REPLY_LENGTH || containsLikelyCredential(question)) {
    await message.reply({
      content:
        "Keep the question under 1,200 characters and do not include any token, password, API key, or client secret.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (!message.guild) return;
  let member;
  try {
    member = await message.guild.members.fetch(targetId);
  } catch {
    await message.reply({
      content: "I couldn’t find that member in this server.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (member.user.bot) {
    await message.reply({
      content: "You can only ask a server member.",
      allowedMentions: noMentions,
    });
    return;
  }
  const request = await findActiveRequestForMember(HOME_GUILD_ID, targetId);
  if (!request || request.stage !== "complete") {
    await message.reply({
      content: "That member does not have a submitted request ready for a staff follow-up.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (await findPendingFollowupForRequest(request.id)) {
    await message.reply({
      content: "There is already an unanswered staff question for that request.",
      allowedMentions: noMentions,
    });
    return;
  }

  const followup = await createFollowup({
    requestId: request.id,
    askedById: message.author.id,
    question: redactLikelyCredentials(question),
  });
  await updateRequest(request.id, {
    status: "waiting_on_member",
    stage: "followup",
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  try {
    await member.send({
      content:
        `The staff team has a follow-up question about ${formatRequestId(request.id)}:\n\n` +
        `${question}\n\nReply to this DM with non-secret information only. Never send tokens, passwords, API keys, or client secrets.`,
      allowedMentions: noMentions,
    });
  } catch {
    await setFollowupStatus(followup.id, "failed");
    await updateRequest(request.id, {
      status: request.assignedToId ? "in_progress" : "received",
      stage: "complete",
      lastActivityAt: new Date(),
    });
    await message.reply({
      content: "I couldn’t DM that member. They may need to enable direct messages from this server.",
      allowedMentions: noMentions,
    });
    return;
  }
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "followup_asked",
    metadata: { followupId: followup.id },
  });
  await postRequestUpdate(
    request,
    `Staff follow-up sent to <@${targetId}> by <@${message.author.id}>.`,
  );
  await message.reply({
    content:
      `I sent your question to <@${targetId}> about ${formatRequestId(request.id)}. Their reply will be sent to \`・data\`.`,
    allowedMentions: noMentions,
  });
}

async function handleStatusCommand(message: Message, args: string[]): Promise<void> {
  const id = parseRequestId(args[1]);
  const targetStatus = args[2]?.toLowerCase();
  const status = targetStatus ? PUBLIC_STATUS_ALIASES[targetStatus] : undefined;
  const note = args.slice(3).join(" ").trim();
  if (!id || !status || args.length < 3) {
    await message.reply({
      content:
        "Usage: `!status REQ-ID received|accepted|in-progress|completed|declined [note]`.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (note.length > MAX_REPLY_LENGTH || (note && containsLikelyCredential(note))) {
    await message.reply({
      content: "Keep the optional note under 1,200 characters and never include credentials.",
      allowedMentions: noMentions,
    });
    return;
  }
  const request = await findRequestById(HOME_GUILD_ID, id);
  if (!request) {
    await message.reply({ content: "I couldn’t find that request.", allowedMentions: noMentions });
    return;
  }
  if (TERMINAL_STATUSES.has(request.status as RequestStatus)) {
    await message.reply({
      content: `${formatRequestId(request.id)} is closed. Use \`!reopen ${formatRequestId(request.id)}\` first.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const closed = TERMINAL_STATUSES.has(status);
  const updated = await updateRequest(request.id, {
    status,
    stage: "complete",
    closedAt: closed ? new Date() : null,
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  if (closed) {
    const pending = await findPendingFollowupForRequest(request.id);
    if (pending) await setFollowupStatus(pending.id, "cancelled");
  }
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "status_changed",
    metadata: { status },
  });
  await postRequestUpdate(
    updated,
    `Status changed to **${formatStatus(status)}** by <@${message.author.id}>.` +
      (note ? `\nStaff note: ${note}` : ""),
  );
  await notifyMember(
    updated,
    `The status of ${formatRequestId(request.id)} is now **${formatStatus(status)}**.` +
      (note ? `\n\nStaff note: ${note}` : ""),
  );
  await message.reply({
    content: `${formatRequestId(request.id)} is now **${formatStatus(status)}**.`,
    allowedMentions: noMentions,
  });
}

async function handleAssignCommand(message: Message, args: string[]): Promise<void> {
  const id = parseRequestId(args[1]);
  const assigneeId = parseUserId(args[2]);
  if (!id || !assigneeId || args.length !== 3 || !message.guild) {
    await message.reply({
      content: "Usage: `!assign REQ-ID @staff-member`.",
      allowedMentions: noMentions,
    });
    return;
  }
  let assignee;
  try {
    assignee = await message.guild.members.fetch(assigneeId);
  } catch {
    await message.reply({
      content: "I couldn’t find that assignee in this server.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (assignee.user.bot) {
    await message.reply({
      content: "Requests can only be assigned to a server member, not a bot.",
      allowedMentions: noMentions,
    });
    return;
  }
  const request = await findRequestById(HOME_GUILD_ID, id);
  if (!request) {
    await message.reply({ content: "I couldn’t find that request.", allowedMentions: noMentions });
    return;
  }
  if (TERMINAL_STATUSES.has(request.status as RequestStatus)) {
    await message.reply({
      content: `${formatRequestId(request.id)} is closed. Reopen it before assigning it.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const updated = await updateRequest(request.id, {
    assignedToId: assigneeId,
    lastActivityAt: new Date(),
  });
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "request_assigned",
    metadata: { assigneeId },
  });
  await postRequestUpdate(
    updated,
    `Assigned to <@${assigneeId}> by <@${message.author.id}>.`,
  );
  await notifyMember(
    updated,
    `${formatRequestId(request.id)} has been assigned to <@${assigneeId}>.`,
  );
  try {
    await assignee.send({
      content: `You were assigned to ${formatRequestId(request.id)}. Request: ${requestLink(request)}`,
      allowedMentions: noMentions,
    });
  } catch {
    console.error(`Could not DM the assignee for ${formatRequestId(request.id)}.`);
  }
  await message.reply({
    content: `${formatRequestId(request.id)} is assigned to <@${assigneeId}>.`,
    allowedMentions: noMentions,
  });
}

async function handleReopenCommand(message: Message, args: string[]): Promise<void> {
  const id = parseRequestId(args[1]);
  if (!id || args.length !== 2) {
    await message.reply({
      content: "Usage: `!reopen REQ-ID`.",
      allowedMentions: noMentions,
    });
    return;
  }
  const request = await findRequestById(HOME_GUILD_ID, id);
  if (!request) {
    await message.reply({ content: "I couldn’t find that request.", allowedMentions: noMentions });
    return;
  }
  if (!TERMINAL_STATUSES.has(request.status as RequestStatus)) {
    await message.reply({
      content: `${formatRequestId(request.id)} is already open.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const updated = await updateRequest(request.id, {
    status: request.stage === "complete" ? "received" : "awaiting_member",
    closedAt: null,
    lastActivityAt: new Date(),
    reminderSentAt: null,
  });
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "request_reopened",
  });
  await postRequestUpdate(
    updated,
    `Request reopened by <@${message.author.id}>. Status: ${formatStatus(updated.status)}.`,
  );
  await notifyMember(
    updated,
    `${formatRequestId(request.id)} has been reopened by the staff team. Current status: ${formatStatus(updated.status)}.`,
  );
  await message.reply({
    content: `${formatRequestId(request.id)} has been reopened.`,
    allowedMentions: noMentions,
  });
}

async function handleCancelCommand(message: Message): Promise<void> {
  const request = await findActiveRequestForMember(HOME_GUILD_ID, message.author.id);
  if (!request) {
    await message.reply({
      content: "You don’t have an open request to cancel.",
      allowedMentions: noMentions,
    });
    return;
  }
  const pending = await findPendingFollowupForRequest(request.id);
  if (pending) await setFollowupStatus(pending.id, "cancelled");
  const updated = await updateRequest(request.id, {
    status: "cancelled",
    stage: "complete",
    closedAt: new Date(),
    lastActivityAt: new Date(),
  });
  await recordRequestEvent({
    requestId: request.id,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "request_cancelled_by_member",
  });
  await postRequestUpdate(updated, `Request cancelled by <@${message.author.id}>.`);
  await message.reply({
    content: `${formatRequestId(request.id)} has been cancelled.`,
    allowedMentions: noMentions,
  });
}

async function handlePermissionCommand(
  message: Message,
  args: string[],
  revoke = false,
): Promise<void> {
  if (!(await hasOwnerCommandAccess(message.author.id))) {
    await message.reply({
      content: "Only the server owner or a delegated owner can grant or revoke command permissions.",
      allowedMentions: noMentions,
    });
    return;
  }
  const requestedCommand = args[1]?.toLowerCase();
  if (requestedCommand === "list") {
    const targetId = parseUserId(args[2]);
    if (args[2] && !targetId) {
      await message.reply({
        content: "Usage: `!perm list [@user]`.",
        allowedMentions: noMentions,
      });
      return;
    }
    const rows = await listCommandPermissions(HOME_GUILD_ID, targetId ?? undefined);
    const lines = rows.map(
      (row) =>
        `• <@${row.userId}> (\`${row.userId}\`) — ${row.effect === "deny" ? "blocked" : "allowed"} ${row.commandName}`,
    );
    try {
      await sendLongDm(
        message.author.id,
        lines.length
          ? `**Command permissions**\n${lines.join("\n")}`
          : "No explicit command permissions are saved.",
      );
      await message.reply({
        content: "I sent the saved command permissions to your DMs.",
        allowedMentions: noMentions,
      });
    } catch {
      await message.reply({
        content: "I couldn’t DM you the permission list. Enable direct messages and try again.",
        allowedMentions: noMentions,
      });
    }
    return;
  }

  const commandName =
    requestedCommand === "all" ? "all" : requestedCommand?.startsWith("!") ? requestedCommand : "";
  const targetId = parseUserId(args[2]);
  if (
    !commandName ||
    (commandName !== "all" &&
      !(STAFF_COMMANDS as readonly string[]).includes(commandName)) ||
    !targetId ||
    args.length !== 3
  ) {
    await message.reply({
      content: revoke
        ? "Usage: `!unperm <command|all> <user-id>`."
        : "Usage: `!perm <command|all> <user-id>` or `!perm list [@user]`.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (targetId === OWNER_ID) {
    await message.reply({
      content: "The server owner already has full access; their permissions cannot be changed.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (!message.guild) return;
  try {
    const member = await message.guild.members.fetch(targetId);
    if (member.user.bot) throw new Error("Bot accounts cannot receive staff commands.");
  } catch (error) {
    await message.reply({
      content:
        error instanceof Error && error.message.includes("Bot accounts")
          ? error.message
          : "That user must be a member of this server.",
      allowedMentions: noMentions,
    });
    return;
  }

  if (revoke) {
    await revokeCommandPermission({
      guildId: HOME_GUILD_ID,
      commandName,
      userId: targetId,
      revokedById: message.author.id,
    });
  } else {
    await grantCommandPermission({
      guildId: HOME_GUILD_ID,
      commandName,
      userId: targetId,
      grantedById: message.author.id,
    });
  }
  await recordRequestEvent({
    requestId: null,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: revoke ? "command_permission_revoked" : "command_permission_granted",
    metadata: { commandName, targetId },
  });
  await message.reply({
    content: revoke
      ? `Permission for \`${commandName}\` was revoked from <@${targetId}>.`
      : `Permission for \`${commandName}\` was granted to <@${targetId}>.`,
    allowedMentions: noMentions,
  });
}

async function handleOwnerCommand(message: Message, args: string[]): Promise<void> {
  if (message.author.id !== OWNER_ID) {
    await message.reply({
      content: "Only the primary server owner can delegate owner commands.",
      allowedMentions: noMentions,
    });
    return;
  }
  const targetId = parseUserId(args[1]);
  if (!targetId || args.length !== 2) {
    await message.reply({
      content: "Usage: `!owner <user-id>`.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (targetId === OWNER_ID) {
    await message.reply({
      content: "The primary owner already has every command.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (!message.guild) return;
  try {
    const member = await message.guild.members.fetch(targetId);
    if (member.user.bot) throw new Error("Bot accounts cannot receive owner access.");
  } catch (error) {
    await message.reply({
      content:
        error instanceof Error && error.message.includes("Bot accounts")
          ? error.message
          : "That user must be a member of this server.",
      allowedMentions: noMentions,
    });
    return;
  }

  await grantOwnerAccess({
    guildId: HOME_GUILD_ID,
    userId: targetId,
    grantedById: message.author.id,
  });
  await recordRequestEvent({
    requestId: null,
    guildId: HOME_GUILD_ID,
    actorId: message.author.id,
    eventType: "owner_access_granted",
    metadata: { targetId },
  });
  await message.reply({
    content: `<@${targetId}> can now use all bot commands except \`!owner\`.`,
    allowedMentions: noMentions,
  });
}

async function handleExportCommand(message: Message, args: string[]): Promise<void> {
  const id = parseRequestId(args[1]);
  if (!id || args.length !== 2) {
    await message.reply({
      content: "Usage: `!export REQ-ID` — DM a text export of one request.",
      allowedMentions: noMentions,
    });
    return;
  }
  const data = await listAllRequestData(HOME_GUILD_ID, id);
  if (!data.request) {
    await message.reply({ content: "I couldn’t find that request.", allowedMentions: noMentions });
    return;
  }
  const lines = [
    `Request: ${formatRequestId(data.request.id)}`,
    `Requester ID: ${data.request.memberId}`,
    `Requester name at submission: ${data.request.memberTag}`,
    `Status: ${data.request.status}`,
    `Assignee ID: ${data.request.assignedToId ?? "unassigned"}`,
    `Created: ${data.request.createdAt.toISOString()}`,
    `Request link: ${requestLink(data.request)}`,
    "",
    "Request description:",
    data.request.description || "(not provided)",
    "",
    "Non-secret setup details:",
    data.request.setupDetails || "(not provided)",
    "",
    "Staff follow-ups:",
    ...(data.followups.length
      ? data.followups.flatMap((item) => [
          `Q (${item.createdAt.toISOString()}): ${item.question}`,
          `A (${item.answeredAt?.toISOString() ?? "unanswered"}): ${item.answer || "(no answer)"}`,
        ])
      : ["(none)"]),
    "",
    "Reference images:",
    ...(data.attachments.length
      ? data.attachments.map(
          (item) =>
            `${item.fileName} — ${item.contentType}, ${item.byteSize} bytes; Discord message ${item.threadMessageId}`,
        )
      : ["(none)"]),
    "",
    "Request events:",
    ...(data.events.length
      ? data.events.map((event) => `${event.createdAt.toISOString()} — ${event.eventType}`)
      : ["(none)"]),
  ];
  const file = new AttachmentBuilder(Buffer.from(lines.join("\n"), "utf8"), {
    name: `${formatRequestId(id)}.txt`,
  });
  try {
    await message.author.send({
      content: `Request export: ${formatRequestId(id)}.`,
      files: [file],
      allowedMentions: noMentions,
    });
    await message.reply({
      content: `I sent the export for ${formatRequestId(id)} to your DMs.`,
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t DM that export. Enable direct messages and try again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleBackupCommand(message: Message): Promise<void> {
  const backup = await listAllRequestsForBackup(HOME_GUILD_ID);
  const content = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      guildId: HOME_GUILD_ID,
      note: "Request content contains only text accepted by the bot's credential screening. Review before sharing.",
      ...backup,
    },
    null,
    2,
  );
  if (Buffer.byteLength(content, "utf8") > 7 * 1024 * 1024) {
    await message.reply({
      content: "The backup is too large to send as one Discord file. Use `!export REQ-ID` for individual requests.",
      allowedMentions: noMentions,
    });
    return;
  }
  const file = new AttachmentBuilder(Buffer.from(content, "utf8"), {
    name: `request-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  try {
    await message.author.send({
      content: "Private request data backup. Keep this file secure.",
      files: [file],
      allowedMentions: noMentions,
    });
    await message.reply({
      content: "I sent the backup to your DMs.",
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t DM the backup. Enable direct messages and try again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleRetentionCommand(message: Message, args: string[]): Promise<void> {
  if (args.length !== 2 || !args[1]) {
    const settings = await getBotSettings(HOME_GUILD_ID);
    const current =
      settings?.retentionDays == null
        ? "off (no automatic deletion)"
        : `${settings.retentionDays} days`;
    await message.reply({
      content: `Current closed-request retention: **${current}**. Use \`!retention <1-3650|off>\`.`,
      allowedMentions: noMentions,
    });
    return;
  }
  const value = args[1].toLowerCase();
  if (value === "off") {
    await setBotSettings(HOME_GUILD_ID, { retentionDays: null });
    await message.reply({
      content: "Automatic deletion of closed requests is off. Open requests are never deleted by retention.",
      allowedMentions: noMentions,
    });
    return;
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    await message.reply({
      content: "Choose `off` or a whole number of days from 1 to 3650.",
      allowedMentions: noMentions,
    });
    return;
  }
  await setBotSettings(HOME_GUILD_ID, { retentionDays: days });
  await message.reply({
    content:
      `Closed requests will be automatically deleted after ${days} days, including their follow-ups, event history, ` +
      "and attachment metadata. Open requests are never deleted by retention. Use `!retention off` to stop future deletion.",
    allowedMentions: noMentions,
  });
}

async function processMaintenance(): Promise<void> {
  const now = Date.now();
  const requests = await listRequestsForMaintenance(HOME_GUILD_ID);
  for (const request of requests) {
    const age = now - request.lastActivityAt.getTime();
    if (age >= MEMBER_EXPIRY_AFTER_MS) {
      const pending = await findPendingFollowupForRequest(request.id);
      if (pending) await setFollowupStatus(pending.id, "expired");
      const expired = await updateRequest(request.id, {
        status: "expired",
        stage: "complete",
        closedAt: new Date(),
      });
      await recordRequestEvent({
        requestId: request.id,
        guildId: HOME_GUILD_ID,
        actorId: client.user?.id ?? OWNER_ID,
        eventType: "request_expired",
      });
      try {
        await postRequestUpdate(expired, "Request expired after 14 days without a member reply.");
      } catch {
        console.error(`Could not post the expiry update for ${formatRequestId(request.id)}.`);
      }
      await notifyMember(
        expired,
        `${formatRequestId(request.id)} expired after 14 days without a reply. Use \`!request\` in the server to start again.`,
      );
      continue;
    }
    if (age >= MEMBER_REMINDER_AFTER_MS && !request.reminderSentAt) {
      try {
        await client.users.fetch(request.memberId).then((user) =>
          user.send({
            content:
              `A reminder for ${formatRequestId(request.id)}: the staff team is waiting for your reply in this DM. ` +
              "Reply with non-secret information only. You can use `!resume` in the server to resend the current question.",
            allowedMentions: noMentions,
          }),
        );
        await updateRequest(request.id, { reminderSentAt: new Date() });
      } catch {
        console.error(`Could not send a pending-request reminder for ${formatRequestId(request.id)}.`);
      }
    }
  }

  const settings = await getBotSettings(HOME_GUILD_ID);
  if (settings?.retentionDays) {
    const cutoff = new Date(now - settings.retentionDays * 24 * 60 * 60 * 1_000);
    const deleted = await deleteRetainedRequests(HOME_GUILD_ID, cutoff);
    if (deleted > 0) console.info(`Removed ${deleted} closed request(s) due to configured retention.`);
  }
}

let maintenanceRunning = false;
async function runMaintenanceSafely(): Promise<void> {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await processMaintenance();
  } catch {
    console.error("The request reminder and retention check failed.");
  } finally {
    maintenanceRunning = false;
  }
}

function getHelpText(): string {
  return (
    "**Bot request commands**\n" +
    "`!help` — list commands\n" +
    "`!request` — start a bot request in DMs\n" +
    "`!resume` — resend the current DM question\n" +
    "`!cancel` — cancel your open request\n\n" +
    "**Staff commands** (the owner grants access with `!perm`)\n" +
    "`!history [page] [status] [user-id]` — DM request history (20 per page)\n" +
    "`!log #channel` — set the metadata-only request log channel\n" +
    "`!ask @user <question>` — ask one non-secret follow-up in DMs\n" +
    "`!status REQ-ID received|accepted|in-progress|completed|declined [note]`\n" +
    "`!assign REQ-ID @staff-member` — assign a request\n" +
    "`!reopen REQ-ID` — reopen a closed request\n" +
    "`!export REQ-ID` — DM a text export of one request\n" +
    "`!backup` — DM a JSON backup of request data\n" +
    "`!retention [days|off]` — configure deletion of closed requests\n\n" +
    "**Owner only**\n" +
    "`!perm !command <user-id>` — grant one staff command\n" +
    "`!perm all <user-id>` — grant all staff commands\n" +
    "`!unperm <command|all> <user-id>` — revoke access\n" +
    "`!perm list [@user]` — view saved permissions\n" +
    "`!owner <user-id>` — grant every command except `!owner` (primary owner only)\n\n" +
    "Only the primary server owner can delegate owner access. Delegated owners can use all commands except `!owner`; staff access can also be granted by command. Roles and Discord server permissions do not grant bot commands. " +
    "Never send tokens, passwords, client secrets, API keys, or other credentials."
  );
}

async function handleGuildCommand(message: Message): Promise<void> {
  if (!message.guild || message.guild.id !== HOME_GUILD_ID) return;
  const args = message.content.trim().split(/\s+/);
  const command = args[0]?.toLowerCase();
  if (command === "!help") {
    await message.reply({ content: getHelpText(), allowedMentions: noMentions });
    return;
  }
  if (command === "!request" && args.length === 1) {
    await startRequest(message);
    return;
  }
  if (command === "!resume" && args.length === 1) {
    await handleResumeCommand(message);
    return;
  }
  if (command === "!cancel" && args.length === 1) {
    await handleCancelCommand(message);
    return;
  }
  if (command === "!owner") {
    await handleOwnerCommand(message, args);
    return;
  }
  if (command === "!perm") {
    await handlePermissionCommand(message, args);
    return;
  }
  if (command === "!unperm") {
    await handlePermissionCommand(message, args, true);
    return;
  }
  if (!(STAFF_COMMANDS as readonly string[]).includes(command ?? "")) return;
  if (!STAFF_COMMANDS.includes(command as (typeof STAFF_COMMANDS)[number])) return;
  if (!(await isAuthorized(message, command as (typeof STAFF_COMMANDS)[number]))) return;

  if (command === "!history") {
    await handleHistoryCommand(message, args);
  } else if (command === "!log") {
    await handleLogCommand(message, args);
  } else if (command === "!ask") {
    await handleAskCommand(message, args);
  } else if (command === "!status") {
    await handleStatusCommand(message, args);
  } else if (command === "!assign") {
    await handleAssignCommand(message, args);
  } else if (command === "!reopen") {
    await handleReopenCommand(message, args);
  } else if (command === "!export") {
    await handleExportCommand(message, args);
  } else if (command === "!backup") {
    await handleBackupCommand(message);
  } else if (command === "!retention") {
    await handleRetentionCommand(message, args);
  }
}

async function handleDirectMessage(message: Message): Promise<void> {
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  try {
    await guild.members.fetch(message.author.id);
  } catch {
    await message.reply({
      content: "This bot only accepts request DMs from members of its configured server.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (await findPendingFollowupForMember(HOME_GUILD_ID, message.author.id)) {
    await handleFollowupReply(message);
    return;
  }
  const request = await findPendingMemberFlowForMember(HOME_GUILD_ID, message.author.id);
  if (!request) return;
  if (request.stage === "request") {
    await handleRequestDetails(message);
  } else if (request.stage === "setup") {
    await handleSetupDetails(message);
  }
}

client.once("clientReady", () => {
  console.info(`Discord request bot ready as ${client.user?.tag ?? "unknown user"}.`);
  void runMaintenanceSafely();
  const timer = setInterval(() => void runMaintenanceSafely(), MAINTENANCE_INTERVAL_MS);
  timer.unref();
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  try {
    if (message.guild) {
      await handleGuildCommand(message);
    } else {
      await handleDirectMessage(message);
    }
  } catch {
    console.error("A message could not be processed by the Discord request bot.");
  }
});

client.on("error", () => {
  console.error("The Discord request bot encountered a connection error.");
});

process.on("unhandledRejection", () => {
  console.error("The Discord request bot encountered an unhandled error.");
});

await verifyStoreReady();
await client.login(BOT_TOKEN);

