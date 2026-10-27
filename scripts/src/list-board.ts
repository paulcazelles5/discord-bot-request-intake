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
  countRequests,
  formatRequestId,
  listRequests,
  type RequestStatus,
} from "./request-store.js";

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

const FILTER_CYCLE: Array<{ id: string; label: string; status?: RequestStatus }> = [
  { id: "all", label: "All" },
  { id: "received", label: "Received", status: "received" },
  { id: "in_progress", label: "In progress", status: "in_progress" },
  { id: "accepted", label: "Accepted", status: "accepted" },
  { id: "needs_info", label: "Needs info", status: "needs_info" },
  { id: "completed", label: "Completed", status: "completed" },
  { id: "declined", label: "Declined", status: "declined" },
  { id: "expired", label: "Expired", status: "expired" },
  { id: "cancelled", label: "Cancelled", status: "cancelled" },
  { id: "awaiting_member", label: "Awaiting", status: "awaiting_member" },
];

const SORT_CYCLE: Array<{ id: "newest" | "oldest" | "status"; label: string }> = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "status", label: "Status" },
];

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
let currentFilterIndex = 0;
let currentSortIndex = 0;
let listMessageId: string | null = null;
let listChannelId: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;

function activeFilter() {
  return FILTER_CYCLE[currentFilterIndex] ?? FILTER_CYCLE[0];
}

function activeSort() {
  return SORT_CYCLE[currentSortIndex] ?? SORT_CYCLE[0];
}

function buildButtons(page: number, totalPages: number) {
  const filter = activeFilter();
  const sort = activeSort();

  const rowNav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}prev`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}page`)
      .setLabel(`Page ${page}/${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}next`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}refresh`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Success),
  );

  const rowFilter = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}filter`)
      .setLabel(`Filter: ${filter.label}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}sort`)
      .setLabel(`Sort: ${sort.label}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}mine`)
      .setLabel("Mes requêtes")
      .setStyle(ButtonStyle.Secondary),
  );

  return [rowNav, rowFilter];
}

async function buildListPayload(page: number): Promise<{
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
  page: number;
  totalPages: number;
}> {
  if (!deps) throw new Error("List board is not started.");

  const filter = activeFilter();
  const sort = activeSort();
  const statusFilter = filter.status;

  const total = await countRequests(deps.guildId, {
    status: statusFilter,
  });
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const requests = await listRequests(deps.guildId, {
    page: safePage,
    pageSize: LIST_PAGE_SIZE,
    status: statusFilter,
    sort: sort.id,
  });

  const header =
    `**Live request list** · ${total} shown · page ${safePage}/${totalPages}\n` +
    `Filter: **${filter.label}** · Sort: **${sort.label}**\n` +
    `_Everyone can use the buttons. “Mes requêtes” is private to you._\n`;

  const lines =
    requests.length === 0
      ? ["No requests for this filter."]
      : requests.map((request) => {
          const status = formatStatus(request.status as RequestStatus);
          return (
            `• **${formatRequestId(request.id)}** · <@${request.memberId}> · \`${request.memberId}\` · **${status}**`
          );
        });

  return {
    content: `${header}\n${lines.join("\n")}`.slice(0, 2000),
    components: buildButtons(safePage, totalPages),
    page: safePage,
    totalPages,
  };
}

async function buildMineContent(userId: string): Promise<string> {
  if (!deps) return "List board is not ready.";
  const mine = await listRequests(deps.guildId, {
    memberId: userId,
    page: 1,
    pageSize: 25,
    sort: "newest",
  });
  if (mine.length === 0) {
    return "You have no requests on record.";
  }
  const lines = mine.map((request) => {
    const status = formatStatus(request.status as RequestStatus);
    const created = request.createdAt
      ? new Date(request.createdAt).toISOString().slice(0, 16).replace("T", " ")
      : "?";
    return `• **${formatRequestId(request.id)}** · **${status}** · created \`${created}\` UTC`;
  });
  return (
    `**Your requests** (${mine.length}${mine.length >= 25 ? "+" : ""})\n` +
    lines.join("\n")
  ).slice(0, 2000);
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

  if (action === "mine") {
    const content = await buildMineContent(interaction.user.id);
    await interaction.reply({ content, ephemeral: true, allowedMentions: noMentions });
    return;
  }

  if (action === "filter") {
    currentFilterIndex = (currentFilterIndex + 1) % FILTER_CYCLE.length;
    currentPage = 1;
  } else if (action === "sort") {
    currentSortIndex = (currentSortIndex + 1) % SORT_CYCLE.length;
    currentPage = 1;
  } else if (action === "prev") {
    currentPage = Math.max(1, currentPage - 1);
  } else if (action === "next") {
    currentPage = currentPage + 1;
  }

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
