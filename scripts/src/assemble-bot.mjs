#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { inflateSync } from "zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const partsDir = join(__dirname, ".bot-parts");
const outFile = join(__dirname, "discord-bot.ts");

const files = readdirSync(partsDir)
  .filter((f) => /^b\d+\.txt$/.test(f))
  .sort();

const b64 = files
  .map((f) => readFileSync(join(partsDir, f), "utf8").replace(/\s+/g, ""))
  .join("");
const compressed = Buffer.from(b64, "base64");
let content = inflateSync(compressed).toString("utf8");

// Strip moderation utilities
content = content.replace(
  /import\s*\{\s*handleUtilityCommand\s*,\s*isUtilityCommand\s*\}\s*from\s*["']\.\/utility-commands\.js["']\s*;\s*/g,
  "",
);
content = content.replace(
  /\s*if\s*\(\s*isUtilityCommand\(command\s*\?\?\s*["']["']\s*\)\s*\)\s*\{\s*await\s+handleUtilityCommand\(message\s*,\s*args\s*,\s*command\s*\?\?\s*["']["']\s*\)\s*;\s*return\s*;\s*\}\s*/g,
  "\n",
);
content = content.replace(
  /\s*"\*\*Utilities\*\* \(requires the corresponding Discord moderation permission\)\\n" \+\n\s*"`!ban[^"]*" \+\n\s*"`!mute[^"]*" \+\n\s*"`!clear[^"]*" \+\n/,
  "\n    ",
);
content = content.replace(
  /\s*"`!ban[^`]*`\s*,\s*`!unban[^`]*`\s*,\s*`!kick[^`]*`\\n" \+\n\s*"`!mute[^"]*" \+\n\s*"`!clear[^"]*" \+\n/g,
  "\n    ",
);

// Ops import
const OPS_IMPORT = `import {
  handleFindCommand,
  handleHealthcheckCommand,
  handleMyRequestsCommand,
  handleStatsCommand,
  processOpsMaintenance,
  recordGroqCall,
} from "./ops-commands.js";
`;
if (!content.includes('from "./ops-commands.js"')) {
  content = content.replace(
    /(from\s*["']\.\/list-board\.js["']\s*;\s*)/,
    `$1\n${OPS_IMPORT}`,
  );
}

// Ops command handlers after !help
const OPS_HANDLERS = `
  if (command === "!find") {
    await handleFindCommand(message, args, {
      guildId: HOME_GUILD_ID,
      isStaff: await isAuthorized(message, "!history"),
    });
    return;
  }
  if (command === "!myrequests") {
    await handleMyRequestsCommand(message, { guildId: HOME_GUILD_ID });
    return;
  }
  if (command === "!stats") {
    await handleStatsCommand(message, { guildId: HOME_GUILD_ID });
    return;
  }
  if (command === "!healthcheck") {
    await handleHealthcheckCommand(message, {
      client,
      guildId: HOME_GUILD_ID,
      groqApiKey: GROQ_API_KEY,
      groqModel: GROQ_MODEL,
      ownerId: OWNER_ID,
    });
    return;
  }
`;
if (!content.includes('command === "!find"')) {
  content = content.replace(
    /(if\s*\(\s*command\s*===\s*["']!help["']\s*\)\s*\{[\s\S]*?return;\s*\}\s*)/,
    `$1${OPS_HANDLERS}`,
  );
}

// Help section
const OPS_HELP =
  '"**Ops / discovery**\\n" +\n' +
  '    "`!find REQ-ID | @user | keyword` — look up requests (own only for members, all for staff)\\n" +\n' +
  '    "`!myrequests` — list your own requests\\n" +\n' +
  '    "`!stats` — request counts by status + Groq session stats\\n" +\n' +
  '    "`!healthcheck` — uptime, memory, DB, Discord, Groq diagnostics\\n\\n" +\n' +
  "    ";
if (!content.includes("Ops / discovery")) {
  content = content.replace(/("\*\*Owner only\*\*\\n" \+)/, `${OPS_HELP}$1`);
}

// Modal handler wiring
if (!content.includes("handleListBoardModal(interaction)")) {
  content = content.replace(
    'client.on("interactionCreate", async (interaction) => {\n  if (!interaction.isButton()) return;',
    `client.on("interactionCreate", async (interaction) => {
  if (interaction.isModalSubmit() && isListBoardModal(interaction.customId)) {
    await handleListBoardModal(interaction);
    return;
  }
  if (!interaction.isButton()) return;`,
  );
}

// List-board modal imports
if (
  (content.includes("isListBoardModal(") || content.includes("handleListBoardModal(")) &&
  (!/handleListBoardModal\s*,/.test(content) || !/isListBoardModal\s*,/.test(content))
) {
  content = content.replace(
    /import\s*\{\s*handleListBoardButton,\s*isListBoardButton,\s*notifyListBoardChanged,\s*startListBoard,\s*\}\s*from\s*["']\.\/list-board\.js["']\s*;/,
    `import {
  handleListBoardButton,
  handleListBoardModal,
  isListBoardButton,
  isListBoardModal,
  notifyListBoardChanged,
  startListBoard,
} from "./list-board.js";`,
  );
}

// Ops maintenance hourly on ready
if (!content.includes("processOpsMaintenance({")) {
  content = content.replace(
    /client\.once\(\s*["']ready["']\s*,\s*async\s*\(\)\s*=>\s*\{/,
    `client.once("ready", async () => {
  setInterval(() => {
    void processOpsMaintenance({
      client,
      guildId: HOME_GUILD_ID,
      botUserId: client.user?.id ?? "bot",
      notifyMember: async (request, text) => {
        try {
          const user = await client.users.fetch(request.memberId);
          await user.send({ content: text.slice(0, 1900) });
        } catch {}
      },
      postInRequestThread: async (request, text) => {
        if (!request.threadId) return;
        const thread = await fetchThread(request.threadId);
        if (!thread) return;
        if (thread.archived) await thread.setArchived(false).catch(() => undefined);
        await thread.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
      },
      postRequestUpdate: async (request, text) => {
        const full = await findRequestById(HOME_GUILD_ID, request.id);
        if (full) await postRequestUpdate(full, text);
      },
    });
  }, 60 * 60 * 1000).unref?.();
`,
  );
}

// Private threads: inject type + invitable, members.add, French message
if (!content.includes("ChannelType.PrivateThread")) {
  content = content.replace(
    "autoArchiveDuration: 10_080,\n        reason:",
    "autoArchiveDuration: 10_080,\n        type: ChannelType.PrivateThread,\n        invitable: false,\n        reason:",
  );
  content = content.replace(
    "updated = await updateRequest(request.id, { threadId: thread.id });\n      await thread.send({",
    `updated = await updateRequest(request.id, { threadId: thread.id });
      try {
        await thread.members.add(authorId);
      } catch (error) {
        console.error(
          "Could not add requester " + authorId + " to private thread for " + formatRequestId(request.id) + ".",
          error,
        );
      }
      await thread.send({`,
  );
  content = content.replace(
    "Staff discussion for ${formatRequestId(request.id)}.\\n` +\n          `Requester: <@${authorId}> (\\`${authorId}\\`)\\nStatus: awaiting member setup details.`,\n        allowedMentions: noMentions,",
    "Discussion privée pour ${formatRequestId(request.id)}.\\n` +\n          `Requester: <@${authorId}> (\\`${authorId}\\`) — tu as accès à ce thread uniquement.\\n` +\n          `Status: awaiting member setup details.`,\n        allowedMentions: { users: [authorId] },",
  );
}

writeFileSync(outFile, content);
console.log(
  `Assembled ${outFile} (${content.length} bytes) from ${files.length} compressed parts (moderation stripped, ops injected).`,
);
console.log("Has ops-commands import:", content.includes("ops-commands.js"));
console.log("Has !find handler:", content.includes('command === "!find"'));
console.log("Has !healthcheck help:", content.includes("!healthcheck"));
console.log("Has PrivateThread:", content.includes("ChannelType.PrivateThread"));
console.log("Has members.add:", content.includes("thread.members.add"));
