import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type GuildMember,
  type GuildTextBasedChannel,
  Partials,
  type Message,
} from "discord.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const HOME_GUILD_ID = "1499704751481294878";
const REQUESTS_CHANNEL_NAME = "・requests";
const DATA_CHANNEL_NAME = "・data";
const MAX_REPLY_LENGTH = 1_200;
const BOT_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../discord-bot-config.json",
);

if (!BOT_TOKEN) {
  throw new Error("Missing required DISCORD_BOT_TOKEN secret.");
}

type RequestStage = "request" | "setup-details" | "staff-follow-up";

interface PendingRequest {
  guildId: string;
  stage: RequestStage;
  requestMessageUrl?: string;
  staffQuestion?: string;
  askedById?: string;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestLogChannelId: string | null = null;

async function loadBotConfig(): Promise<void> {
  try {
    const config = JSON.parse(await readFile(BOT_CONFIG_PATH, "utf8")) as {
      requestLogChannelId?: unknown;
    };
    if (
      typeof config.requestLogChannelId === "string" &&
      /^\d{17,20}$/.test(config.requestLogChannelId)
    ) {
      requestLogChannelId = config.requestLogChannelId;
    } else {
      console.error("Discord bot configuration is missing a valid request log channel ID.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Could not read the Discord bot configuration.");
    }
  }
}

async function saveBotConfig(): Promise<void> {
  await writeFile(
    BOT_CONFIG_PATH,
    `${JSON.stringify({ requestLogChannelId }, null, 2)}\n`,
    "utf8",
  );
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

const noMentions = { parse: [] as const };

function redactLikelyCredentials(value: string): string {
  return value
    .replace(/\bmfa\.[A-Za-z\d_-]{20,}\b/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{5,}\.[A-Za-z\d_-]{20,}\b/g, "[REDACTED CREDENTIAL]")
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
  if (value.length <= 1_750) return value;
  return `${value.slice(0, 1_700)}\n\n[Message shortened to fit Discord's limit.]`;
}

async function findStaffChannel(name: string): Promise<GuildTextBasedChannel | null> {
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(
    (candidate) => candidate?.name === name && candidate.isTextBased(),
  );
  return channel?.isTextBased() ? channel : null;
}

async function fetchGuildTextChannel(channelId: string): Promise<GuildTextBasedChannel | null> {
  const guild = await client.guilds.fetch(HOME_GUILD_ID);
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isThread()) return null;
  return channel;
}

function isStaffCommand(message: Message): boolean {
  return message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function logRequestCommand(message: Message): Promise<void> {
  if (!requestLogChannelId) return;
  try {
    const channel = await fetchGuildTextChannel(requestLogChannelId);
    if (!channel) throw new Error("Configured request log channel is unavailable.");
    const timestamp = Math.floor(message.createdTimestamp / 1_000);
    await channel.send({
      content:
        `**New request command**\n` +
        `Member: ${message.author.username} (<@${message.author.id}> / \`${message.author.id}\`)\n` +
        `Time: <t:${timestamp}:F>\n` +
        `Command channel: <#${message.channelId}>`,
      allowedMentions: noMentions,
    });
  } catch {
    console.error("Could not post request activity to the configured log channel.");
  }
}

async function startRequest(message: Message): Promise<void> {
  if (!message.guild || message.guild.id !== HOME_GUILD_ID) return;

  await logRequestCommand(message);

  if (pendingRequests.has(message.author.id)) {
    await message.reply({
      content: "You already have a request in progress. Please continue in your DMs.",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
    await message.author.send(
      "Please describe the bot you'd like us to build: its purpose, who will use it, and its main features.\n\n" +
        "Never send bot tokens, passwords, API keys, client secrets, or other credentials. " +
        "After the staff team provides the code, you will add any required credentials yourself in your hosting provider's private secrets.",
    );
    pendingRequests.set(message.author.id, {
      guildId: HOME_GUILD_ID,
      stage: "request",
    });
    await message.reply({
      content: "I’ve sent you a DM to collect your bot request. Please check your message requests if you don’t see it.",
      allowedMentions: noMentions,
    });
  } catch {
    pendingRequests.delete(message.author.id);
    await message.reply({
      content: "I couldn’t DM you. Please enable direct messages from this server, then try `!request` again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleRequestDetails(message: Message, state: PendingRequest): Promise<void> {
  const submittedText = message.content.trim();
  if (!submittedText) {
    await message.reply("Please send your bot request as a text message.");
    return;
  }
  if (submittedText.length > MAX_REPLY_LENGTH) {
    await message.reply(
      `Please shorten your message to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer, then send it again.`,
    );
    return;
  }
  if (containsLikelyCredential(submittedText)) {
    await message.reply(
      "That message appears to contain a credential, so I did not forward it. Please delete it from this DM and resend your request without any token, password, API key, client secret, or other credential.",
    );
    return;
  }

  const requestText = redactLikelyCredentials(submittedText);
  try {
    const requestsChannel = await findStaffChannel(REQUESTS_CHANNEL_NAME);
    if (!requestsChannel) throw new Error("Requests channel is unavailable.");

    const sentRequest = await requestsChannel.send({
      content: capForDiscord(
        `**New bot request**\nRequested by: <@${message.author.id}> (\`${message.author.id}\`)\n\n${requestText}`,
      ),
      allowedMentions: noMentions,
    });

    state.stage = "setup-details";
    state.requestMessageUrl = sentRequest.url;
    pendingRequests.set(message.author.id, state);

    await message.reply(
      "Thanks — I’ve sent your request to the staff team in `・requests`.\n\n" +
        "Now send any **non-secret** setup details that may help, such as the application/client ID (if you already have one), " +
        "required permissions or intents, preferred language/library, and hosting needs. " +
        "The staff team will provide the code and setup instructions; you will add any required token or OAuth2 client secret yourself " +
        "in your hosting provider's private secrets. Never send credentials in Discord.",
    );
  } catch {
    pendingRequests.delete(message.author.id);
    await message.reply(
      "I couldn’t deliver your request to the staff channel. Please contact the staff team in the server and do not send any credentials.",
    );
  }
}

async function handleSetupDetails(message: Message, state: PendingRequest): Promise<void> {
  const submittedText = message.content.trim();
  if (!submittedText) {
    await message.reply("Please send your non-secret setup details as a text message.");
    return;
  }
  if (submittedText.length > MAX_REPLY_LENGTH) {
    await message.reply(
      `Please shorten your message to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer, then send it again.`,
    );
    return;
  }
  if (containsLikelyCredential(submittedText)) {
    await message.reply(
      "That message appears to contain a credential, so I did not forward it. Please delete it from this DM and resend only non-secret setup details.",
    );
    return;
  }

  const setupDetails = redactLikelyCredentials(submittedText);
  try {
    const dataChannel = await findStaffChannel(DATA_CHANNEL_NAME);
    if (!dataChannel) throw new Error("Data channel is unavailable.");

    await dataChannel.send({
      content: capForDiscord(
        `**Non-secret bot setup details**\nRequested by: <@${message.author.id}> (\`${message.author.id}\`)\n` +
          `Request: ${state.requestMessageUrl ?? "See ・requests"}\n\n${setupDetails}`,
      ),
      allowedMentions: noMentions,
    });

    pendingRequests.delete(message.author.id);
    await message.reply(
      "Your setup details have been sent to the staff team in `・data`. Your request is complete.",
    );
  } catch {
    await message.reply(
      "I couldn’t deliver those details to the staff channel. Your request is still open; please try sending the non-secret details again later.",
    );
  }
}

async function handleHistoryCommand(message: Message): Promise<void> {
  try {
    const requestsChannel = await findStaffChannel(REQUESTS_CHANNEL_NAME);
    if (!requestsChannel) throw new Error("Requests channel is unavailable.");

    const recentRequests = (await requestsChannel.messages.fetch({ limit: 100 }))
      .filter(
        (entry) =>
          entry.author.id === client.user?.id &&
          entry.content.startsWith("**New bot request**"),
      )
      .first(20);

    const lines = recentRequests.map((entry) => {
      const requesterId = entry.content.match(/Requested by: <@!?(\d+)>/)?.[1];
      const requester = requesterId ? `<@${requesterId}>` : "Unknown member";
      return `• <t:${Math.floor(entry.createdTimestamp / 1_000)}:f> — ${requester} — [open request](${entry.url})`;
    });

    await message.author.send({
      content:
        lines.length > 0
          ? `**Latest ${lines.length} bot requests from ・requests**\n${lines.join("\n")}`
          : "There are no recent bot requests in `・requests`.",
      allowedMentions: noMentions,
    });
    await message.reply({
      content: "I sent the latest request links to your DMs.",
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t access the request history or DM you. Check my channel permissions and your DM settings.",
      allowedMentions: noMentions,
    });
  }
}

async function handleLogCommand(message: Message, args: string[]): Promise<void> {
  const channelArgument = args[1];
  const mentionMatch = channelArgument?.match(/^<#(\d+)>$/);
  const idMatch = channelArgument?.match(/^(\d+)$/);
  const channelId = mentionMatch?.[1] ?? idMatch?.[1];
  if (!channelId || args.length !== 2) {
    await message.reply({
      content: "Usage: `!log #channel` — set the channel that receives request activity logs.",
      allowedMentions: noMentions,
    });
    return;
  }

  try {
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

    const previousLogChannelId = requestLogChannelId;
    requestLogChannelId = channel.id;
    try {
      await saveBotConfig();
    } catch {
      requestLogChannelId = previousLogChannelId;
      await message.reply({
        content: "I couldn’t save the log channel setting. Please try again.",
        allowedMentions: noMentions,
      });
      return;
    }

    await message.reply({
      content:
        `Request activity logging is enabled in <#${channel.id}>. I’ll post the member’s name, user ID, time, and command channel whenever someone runs \`!request\`; I won’t copy DM contents.`,
      allowedMentions: noMentions,
    });
  } catch {
    await message.reply({
      content: "I couldn’t configure that log channel. Check my permissions and try again.",
      allowedMentions: noMentions,
    });
  }
}

async function handleAskCommand(message: Message, args: string[]): Promise<void> {
  const userArgument = args[1];
  const mentionMatch = userArgument?.match(/^<@!?(\d+)>$/);
  const idMatch = userArgument?.match(/^(\d+)$/);
  const targetId = mentionMatch?.[1] ?? idMatch?.[1];
  const question = args.slice(2).join(" ").trim();

  if (!targetId || !question) {
    await message.reply({
      content: "Usage: `!ask @user <question>` — send a custom request follow-up in DMs.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (question.length > MAX_REPLY_LENGTH) {
    await message.reply({
      content: `Keep the question to ${MAX_REPLY_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      allowedMentions: noMentions,
    });
    return;
  }
  if (containsLikelyCredential(question)) {
    await message.reply({
      content: "I can’t send a question that appears to contain a credential. Never share tokens or secrets in Discord.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (pendingRequests.has(targetId)) {
    await message.reply({
      content: "That member already has an active DM flow. Wait for it to finish before sending another question.",
      allowedMentions: noMentions,
    });
    return;
  }

  const guild = message.guild;
  if (!guild) return;
  let member: GuildMember;
  try {
    member = await guild.members.fetch(targetId);
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

  pendingRequests.set(targetId, {
    guildId: HOME_GUILD_ID,
    stage: "staff-follow-up",
    staffQuestion: question,
    askedById: message.author.id,
  });

  try {
    await member.send({
      content:
        `The staff team has a follow-up question about your bot request:\n\n${question}\n\n` +
        "Reply to this DM with your answer. Never send a bot token, password, API key, client secret, or other credential.",
      allowedMentions: noMentions,
    });
  } catch {
    pendingRequests.delete(targetId);
    await message.reply({
      content: "I couldn’t DM that member. They may need to enable direct messages from this server.",
      allowedMentions: noMentions,
    });
    return;
  }

  await message.reply({
    content: `I sent your question to <@${targetId}> in DMs. Their reply will be sent to \`・data\`.`,
    allowedMentions: noMentions,
  });
}

async function handleStaffFollowupReply(
  message: Message,
  state: PendingRequest,
): Promise<void> {
  const answer = message.content.trim();
  if (!answer) {
    await message.reply("Please send your answer as a text message.");
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
      "That message appears to contain a credential, so I did not forward it. Please delete it from this DM and resend only non-secret information.",
    );
    return;
  }

  try {
    const dataChannel = await findStaffChannel(DATA_CHANNEL_NAME);
    if (!dataChannel) throw new Error("Data channel is unavailable.");

    await dataChannel.send({
      content: capForDiscord(
        `**Staff follow-up reply**\nMember: <@${message.author.id}> (\`${message.author.id}\`)\n` +
          `Asked by: <@${state.askedById ?? "unknown"}>\n` +
          `Question: ${state.staffQuestion ?? "See staff DM"}\n\nAnswer:\n${answer}`,
      ),
      allowedMentions: noMentions,
    });

    pendingRequests.delete(message.author.id);
    await message.reply("Thanks — I sent your reply to the staff team.");
  } catch {
    await message.reply(
      "I couldn’t deliver your reply to the staff channel. Your follow-up is still open; please try again later.",
    );
  }
}

client.once("clientReady", () => {
  console.info(`Discord request bot ready as ${client.user?.tag ?? "unknown user"}.`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    if (message.guild) {
      if (message.guild.id !== HOME_GUILD_ID) return;
      const args = message.content.trim().split(/\s+/);
      const command = args[0]?.toLowerCase();
      if (command === "!help") {
        await message.reply({
          content:
            "**Bot request commands**\n" +
              "`!help` — list available commands\n" +
              "`!request` — start a bot request in DMs\n\n" +
              "**Staff only (Manage Server permission)**\n" +
              "`!history` — DM links to the 20 latest requests\n" +
              "`!log #channel` — choose where request activity is logged\n" +
              "`!ask @user <question>` — ask a member a follow-up in DMs",
          allowedMentions: noMentions,
        });
      } else if (command === "!request" && args.length === 1) {
        await startRequest(message);
      } else if (
        command === "!history" ||
        command === "!log" ||
        command === "!ask"
      ) {
        if (!isStaffCommand(message)) {
          await message.reply({
            content: "This command is staff-only and requires the Manage Server permission.",
            allowedMentions: noMentions,
          });
          return;
        }

        if (command === "!history" && args.length === 1) {
          await handleHistoryCommand(message);
        } else if (command === "!log") {
          await handleLogCommand(message, args);
        } else if (command === "!ask") {
          await handleAskCommand(message, args);
        } else {
          await message.reply({
            content: "Usage: `!history`",
            allowedMentions: noMentions,
          });
        }
      }
      return;
    }

    const state = pendingRequests.get(message.author.id);
    if (!state || state.guildId !== HOME_GUILD_ID) return;

    if (state.stage === "request") {
      await handleRequestDetails(message, state);
    } else if (state.stage === "setup-details") {
      await handleSetupDetails(message, state);
    } else {
      await handleStaffFollowupReply(message, state);
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

await loadBotConfig();
await client.login(BOT_TOKEN);
