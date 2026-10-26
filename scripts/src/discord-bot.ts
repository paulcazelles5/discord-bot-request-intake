import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type ButtonInteraction,
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
  getRequestDailyLimit,
  hasRequestLimitBypass,
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
  setRequestDailyLimit,
  setRequestLimitBypass,
  setFollowupStatus,
  updateRequest,
  verifyStoreReady,
  type RequestStatus,
} from "./request-store.js";
import { handleUtilityCommand, isUtilityCommand } from "./utility-commands.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const HOME_GUILD_ID = "1499704751481294878";
const OWNER_ID = "1264183250243420211";
const REQUESTS_CHANNEL_NAME = "・requests";
const DATA_CHANNEL_NAME = "・data";
const MAX_REPLY_LENGTH = 1_200;
const MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_IMAGES = 3;
const MAX_CODE_DELIVERY_BYTES = 25 * 1024 * 1024;
const REQUEST_NEXT_BUTTON_PREFIX = "request-next:";
const MEMBER_REMINDER_AFTER_MS = 48 * 60 * 60 * 1_000;
const MEMBER_EXPIRY_AFTER_MS = 14 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1_000;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const STAFF_COMMANDS = [
  "!history",
  "!log",
  "!ask",
  "!code",
  "!aicreate",
  "!status",
  "!assign",
  "!reopen",
  "!export",
  "!backup",
  "!retention",
] as const;
