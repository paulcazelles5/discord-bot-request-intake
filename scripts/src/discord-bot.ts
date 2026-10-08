import {
  Client,
  GatewayIntentBits,
  type GuildTextBasedChannel,
  Partials,
  type Message,
} from "discord.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const HOME_GUILD_ID = "1499704751481294878";
const REQUESTS_CHANNEL_NAME = "・requests";
const DATA_CHANNEL_NAME = "・data";
const MAX_REPLY_LENGTH = 1_200;

if (!BOT_TOKEN) {
  throw new Error("Missing required DISCORD_BOT_TOKEN secret.");
}

type RequestStage = "request" | "setup-details";

interface PendingRequest {
  guildId: string;
  stage: RequestStage;
  requestText?: string;
  requestMessageUrl?: string;
}

const pendingRequests = new Map<string, PendingRequest>();

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

async function startRequest(message: Message): Promise<void> {
  if (!message.guild || message.guild.id !== HOME_GUILD_ID) return;

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
        "The staff team will configure any required secrets securely.",
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
    state.requestText = requestText;
    state.requestMessageUrl = sentRequest.url;
    pendingRequests.set(message.author.id, state);

    await message.reply(
      "Thanks — I’ve sent your request to the staff team in `・requests`.\n\n" +
        "Now send any **non-secret** setup details that may help, such as the application/client ID (if you already have one), " +
        "required permissions or intents, preferred language/library, and hosting needs. " +
        "Do not send a bot token, client secret, password, API key, or any other credential.",
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

client.once("clientReady", () => {
  console.info(`Discord request bot ready as ${client.user?.tag ?? "unknown user"}.`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  try {
    if (message.guild) {
      if (message.guild.id !== HOME_GUILD_ID) return;
      const command = message.content.trim().toLowerCase();
      if (command === "!help") {
        await message.reply({
          content:
            "**Bot request commands**\n`!help` — list available commands\n`!request` — start a bot request in DMs",
          allowedMentions: noMentions,
        });
      } else if (command === "!request") {
        await startRequest(message);
      }
      return;
    }

    const state = pendingRequests.get(message.author.id);
    if (!state || state.guildId !== HOME_GUILD_ID) return;

    if (state.stage === "request") {
      await handleRequestDetails(message, state);
    } else {
      await handleSetupDetails(message, state);
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

await client.login(BOT_TOKEN);
