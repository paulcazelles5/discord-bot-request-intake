import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type Client,
  type TextChannel,
} from "discord.js";
import {
  formatRequestId,
  listRequests,
  type RequestStatus,
} from "./request-store.js";

async function countRequests(guildId: string): Promise<number> {
  let page = 1;
  let total = 0;
  while (page <= 100) {
    const batch = await listRequests(guildId, { page, pageSize: 100 });
    total += batch.length;
    if (batch.length < 100) break;
    page += 1;
  }
  return total;
}

const LIST_CHANNEL_NAME = "・list";
const LIST_PAGE_SIZE = 12;
const LIST_REFRESH_MS = 30_000;
const LIST_BUTTON_PREFIX = "request-list:";
const noMentions = { parse: [] as const };

const STATUS_COLORS: Record<string, string> = {
  awaiting_member: "🟠",
  waiting_on_member: "🟠",
  received: "🟡",
  needs_info: "⚪",
  accepted: "🟣",
  in_progress: "🔵",
  completed: "🟢",
  declined: "🔴",
  cancelled: "⚫",
  expired: "🟤",
};

function formatStatus(status: string): string {
  const emoji = STATUS_COLORS[status] ?? "▪️";
  return `${emoji} ${status.replaceAll("_", " ")}`;
}

export type ListBoardDeps = {
  client: Client;
  guildId: string;
};

let deps: ListBoardDeps | null = null;
let currentPage = 1;
let listMessageId: string | null = null;
let listChannelId: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;

function buildButtons(page: number, totalPages: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}prev`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}page`)
      .setLabel(`Page ${page}/${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}next`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}refresh`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Success),
  );
}

async function buildListPayload(page: number): Promise<{
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
  page: number;
  totalPages: number;
}> {
  if (!deps) throw new Error("List board is not started.");

  const total = await countRequests(deps.guildId);
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const requests = await listRequests(deps.guildId, {
    page: safePage,
    pageSize: LIST_PAGE_SIZE,
  });

  const header =
    `**Live request list** · ${total} total · page ${safePage}/${totalPages}\n` +
    `_Updates automatically every 30s and when a status changes._\n`;

  const lines =
    requests.length === 0
      ? ["No requests yet."]
      : requests.map((request) => {
          const status = formatStatus(request.status as RequestStatus);
          return (
            `• **${formatRequestId(request.id)}** · <@${request.memberId}> · \`${request.memberId}\` · **${status}**`
          );
        });

  return {
    content: `${header}\n${lines.join("\n")}`.slice(0, 2000),
    components: [buildButtons(safePage, totalPages)],
    page: safePage,
    totalPages,
  };
}

async function findListChannel(): Promise<TextChannel | null> {
  if (!deps) return null;
  const guild = await deps.client.guilds.fetch(deps.guildId);
  await guild.channels.fetch();
  const channel = guild.channels.cache.find(
    (candidate) =>
      candidate?.type === ChannelType.GuildText && candidate.name === LIST_CHANNEL_NAME,
  );
  return channel?.type === ChannelType.GuildText ? channel : null;
}

async function ensureListMessage(channel: TextChannel) {
  if (listMessageId) {
    try {
      const existing = await channel.messages.fetch(listMessageId);
      return existing;
    } catch {
      listMessageId = null;
    }
  }

  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    const mine = recent.find(
      (message) =>
        message.author.id === deps?.client.user?.id &&
        message.content.startsWith("**Live request list**"),
    );
    if (mine) {
      listMessageId = mine.id;
      return mine;
    }
  } catch {
    // fall through to create
  }

  const payload = await buildListPayload(currentPage);
  currentPage = payload.page;
  const sent = await channel.send({
    content: payload.content,
    components: payload.components,
    allowedMentions: noMentions,
  });
  listMessageId = sent.id;
  listChannelId = channel.id;
  return sent;
}

export async function refreshListBoard(forcePage?: number): Promise<void> {
  if (!deps || refreshInFlight) return;
  refreshInFlight = true;
  try {
    const channel = await findListChannel();
    if (!channel) {
      console.error(
        `List board: channel ${LIST_CHANNEL_NAME} not found. Create it and grant the bot Send Messages + Read Message History.`,
      );
      return;
    }
    listChannelId = channel.id;
    if (typeof forcePage === "number") currentPage = forcePage;

    const message = await ensureListMessage(channel);
    const payload = await buildListPayload(currentPage);
    currentPage = payload.page;

    await message.edit({
      content: payload.content,
      components: payload.components,
      allowedMentions: noMentions,
    });
    listMessageId = message.id;
  } catch (error) {
    console.error("List board could not be refreshed.", error);
  } finally {
    refreshInFlight = false;
  }
}

export function notifyListBoardChanged(): void {
  void refreshListBoard();
}

export function isListBoardButton(customId: string): boolean {
  return customId.startsWith(LIST_BUTTON_PREFIX);
}

export async function handleListBoardButton(interaction: ButtonInteraction): Promise<void> {
  if (!deps || !isListBoardButton(interaction.customId)) return;

  const action = interaction.customId.slice(LIST_BUTTON_PREFIX.length);
  const total = await countRequests(deps.guildId);
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));

  if (action === "prev") currentPage = Math.max(1, currentPage - 1);
  else if (action === "next") currentPage = Math.min(totalPages, currentPage + 1);

  const payload = await buildListPayload(currentPage);
  currentPage = payload.page;

  await interaction.update({
    content: payload.content,
    components: payload.components,
    allowedMentions: noMentions,
  });

  if (interaction.message?.id) {
    listMessageId = interaction.message.id;
    listChannelId = interaction.channelId;
  }
}

export function startListBoard(client: Client, guildId: string): void {
  deps = { client, guildId };
  void refreshListBoard(1);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshListBoard(), LIST_REFRESH_MS);
  if (typeof refreshTimer === "object" && "unref" in refreshTimer) {
    refreshTimer.unref();
  }
}
