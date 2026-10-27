import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import {
  countRequests,
  formatRequestId,
  listRequests,
  parseRequestId,
  type RequestStatus,
} from "./request-store.js";
import { askMemberForInfo } from "./ops-commands.js";

const LIST_CHANNEL_NAME = "・list";
const LIST_PAGE_SIZE = 12;
const LIST_REFRESH_MS = 30_000;
const LIST_BUTTON_PREFIX = "request-list:";
const ASK_INFO_MODAL_ID = "request-list:askinfo-modal";
const ASK_INFO_REQ_FIELD = "requestId";
const ASK_INFO_Q_FIELD = "question";
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
  isStaff?: (userId: string) => Promise<boolean>;
  postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
};

let deps: ListBoardDeps | null = null;
let currentPage = 1;
let currentFilterIndex = 0;
let currentSortIndex = 0;
let listMessageId: string | null = null;
let listChannelId: string | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function notifyListBoardChanged(): void {
  void refreshListBoard();
}

export { notifyListBoardChanged };

async function resolveListChannel(client: Client, guildId: string): Promise<TextChannel | null> {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const candidate = channels.find(
    (c) =>
      c?.type === ChannelType.GuildText && c.name === LIST_CHANNEL_NAME,
  );
  return candidate?.type === ChannelType.GuildText ? (candidate as TextChannel) : null;
}

function buildButtons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder>[] {
  const filter = FILTER_CYCLE[currentFilterIndex]!;
  const sort = SORT_CYCLE[currentSortIndex]!;
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}prev`)
      .setLabel("◀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}refresh`)
      .setLabel(`Page ${page}/${Math.max(totalPages, 1)}`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}next`)
      .setLabel("▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}filter`)
      .setLabel(`Filter: ${filter.label}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}sort`)
      .setLabel(`Sort: ${sort.label}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}mine`)
      .setLabel("Mes requêtes")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${LIST_BUTTON_PREFIX}askinfo`)
      .setLabel("Demander infos")
      .setStyle(ButtonStyle.Primary),
  );
  return [row1, row2];
}

async function buildListPayload(page: number): Promise<{
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
  page: number;
  totalPages: number;
}> {
  if (!deps) throw new Error("List board not started");
  const filter = FILTER_CYCLE[currentFilterIndex]!;
  const sort = SORT_CYCLE[currentSortIndex]!;
  const status = filter.status;
  const total = await countRequests(deps.guildId, status ? { status } : undefined);
  const totalPages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * LIST_PAGE_SIZE;
  const rows = await listRequests(deps.guildId, {
    status,
    limit: LIST_PAGE_SIZE,
    offset,
    sort: sort.id,
  });
  const lines = rows.map((r) => {
    const id = formatRequestId(r.id);
    const st = formatStatus(r.status);
    const title = (r.title || r.summary || "(sans titre)").replace(/\n/g, " ").slice(0, 60);
    const who = r.memberTag ? `@${r.memberTag}` : r.memberId;
    return `**${id}** ${st} — ${title} — ${who}`;
  });
  const header =
    `**Live requests** · filter **${filter.label}** · sort **${sort.label}** · ${total} total\n` +
    `_Everyone can use the buttons. “Mes requêtes” is private to you._\n`;
  const body = lines.length ? lines.join("\n") : "_Aucune requête pour ce filtre._";
  return {
    content: `${header}\n${body}`.slice(0, 1900),
    components: buildButtons(safePage, totalPages),
    page: safePage,
    totalPages,
  };
}

export async function refreshListBoard(page?: number): Promise<void> {
  if (!deps) return;
  const targetPage = page ?? currentPage;
  const channel = await resolveListChannel(deps.client, deps.guildId);
  if (!channel) return;
  const payload = await buildListPayload(targetPage);
  currentPage = payload.page;
  try {
    if (listMessageId && listChannelId === channel.id) {
      const msg = await channel.messages.fetch(listMessageId).catch(() => null);
      if (msg) {
        await msg.edit({
          content: payload.content,
          components: payload.components,
          allowedMentions: noMentions,
        });
        return;
      }
    }
    const sent = await channel.send({
      content: payload.content,
      components: payload.components,
      allowedMentions: noMentions,
    });
    listMessageId = sent.id;
    listChannelId = channel.id;
  } catch (err) {
    console.error("refreshListBoard failed", err);
  }
}

export function isListBoardButton(customId: string): boolean {
  return customId.startsWith(LIST_BUTTON_PREFIX);
}

export async function handleListBoardButton(interaction: ButtonInteraction): Promise<void> {
  if (!deps || !isListBoardButton(interaction.customId)) return;
  const action = interaction.customId.slice(LIST_BUTTON_PREFIX.length);

  if (action === "mine") {
    const mine = await listRequests(deps.guildId, {
      memberId: interaction.user.id,
      limit: 20,
      sort: "newest",
    });
    if (!mine.length) {
      await interaction.reply({
        content: "Tu n’as aucune requête enregistrée.",
        ephemeral: true,
        allowedMentions: noMentions,
      });
      return;
    }
    const lines = mine.map((r) => {
      const id = formatRequestId(r.id);
      const st = formatStatus(r.status);
      const title = (r.title || r.summary || "(sans titre)").replace(/\n/g, " ").slice(0, 50);
      return `**${id}** ${st} — ${title}`;
    });
    await interaction.reply({
      content: `**Tes requêtes** (${mine.length})\n${lines.join("\n")}`.slice(0, 1900),
      ephemeral: true,
      allowedMentions: noMentions,
    });
    return;
  }

  if (action === "askinfo") {
    const staffOk = deps.isStaff ? await deps.isStaff(interaction.user.id) : false;
    if (!staffOk) {
      await interaction.reply({
        content: "Seul le staff peut demander des informations.",
        ephemeral: true,
        allowedMentions: noMentions,
      });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(ASK_INFO_MODAL_ID)
      .setTitle("Demander des infos au membre");
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(ASK_INFO_REQ_FIELD)
          .setLabel("ID requête (REQ-00042 ou 42)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(ASK_INFO_Q_FIELD)
          .setLabel("Question / infos demandées")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500),
      ),
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === "filter") {
    currentFilterIndex = (currentFilterIndex + 1) % FILTER_CYCLE.length;
  } else if (action === "sort") {
    currentSortIndex = (currentSortIndex + 1) % SORT_CYCLE.length;
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

export function isListBoardModal(customId: string): boolean {
  return customId === ASK_INFO_MODAL_ID;
}

export async function handleListBoardModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!deps || !isListBoardModal(interaction.customId)) return;
  const staffOk = deps.isStaff ? await deps.isStaff(interaction.user.id) : false;
  if (!staffOk) {
    await interaction.reply({
      content: "Seul le staff peut demander des informations.",
      ephemeral: true,
      allowedMentions: noMentions,
    });
    return;
  }
  const rawId = interaction.fields.getTextInputValue(ASK_INFO_REQ_FIELD).trim();
  const question = interaction.fields.getTextInputValue(ASK_INFO_Q_FIELD).trim();
  const requestId = parseRequestId(rawId);
  if (!requestId) {
    await interaction.reply({
      content: "ID de requête invalide. Exemple : `REQ-00042` ou `42`.",
      ephemeral: true,
      allowedMentions: noMentions,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const postUpdate =
    deps.postRequestUpdate ??
    (async () => {
      /* no-op if not wired */
    });
  const result = await askMemberForInfo({
    guildId: deps.guildId,
    requestId,
    askedById: interaction.user.id,
    question,
    client: deps.client,
    postRequestUpdate: postUpdate,
  });
  if (!result.ok) {
    await interaction.editReply({ content: result.error });
    return;
  }
  await interaction.editReply({
    content: `Question envoyée au membre pour **${formatRequestId(result.requestId)}**. Sa réponse arrivera dans \`・data\`.`,
  });
  notifyListBoardChanged();
}

export function startListBoard(
  client: Client,
  guildId: string,
  extras?: {
    isStaff?: (userId: string) => Promise<boolean>;
    postRequestUpdate?: (request: { id: number }, text: string) => Promise<void>;
  },
): void {
  deps = {
    client,
    guildId,
    isStaff: extras?.isStaff,
    postRequestUpdate: extras?.postRequestUpdate,
  };
  void refreshListBoard(1);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshListBoard(), LIST_REFRESH_MS);
  if (typeof refreshTimer === "object" && "unref" in refreshTimer) {
    refreshTimer.unref();
  }
}
