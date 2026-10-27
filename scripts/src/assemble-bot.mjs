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

// Remove moderation utility commands (import, routing, help section)
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

const OPS_HELP = `"**Ops / discovery**\\n" +
    "\`!find REQ-ID | @user | keyword\` — look up requests (own only for members, all for staff)\\n" +
    "\`!myrequests\` — list your own requests\\n" +
    "\`!stats\` — request counts by status + Groq session stats\\n" +
    "\`!healthcheck\` — uptime, memory, DB, Discord, Groq diagnostics\\n\\n" +
    `;

if (!content.includes("Ops / discovery")) {
  content = content.replace(
    /("\*\*Owner only\*\*\\n" \+)/,
    `${OPS_HELP}$1`,
  );
}

if (!content.includes("recordGroqCall({")) {
  content = content.replace(
    /(async function generateBotCodeWithGroq\(description: string\): Promise<string> \{\n  if \(!GROQ_API_KEY\) \{\n    throw new Error\("GROQ_API_KEY secret is not configured\."\);\n  }\n)/,
    `$1
  const t0 = Date.now();
  let ok = false;
  let errMsg: string | undefined;
  try {
`,
  );

  content = content.replace(
    /(\/\/ Strip accidental markdown fences if the model still adds them\n  return content\n    \.replace\(\/\^```\(\?:js\|javascript\)\?\\n\?\/i, ""\)\n    \.replace\(\/\\n\?```\$\/i, ""\)\n    \.trim\(\);\n\})/,
    `// Strip accidental markdown fences if the model still adds them
  ok = true;
  return content
    .replace(/^\`\`\`(?:js|javascript)?\\n?/i, "")
    .replace(/\\n?\`\`\`$/i, "")
    .trim();
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    recordGroqCall({ ok, latencyMs: Date.now() - t0, error: errMsg });
  }
}`,
  );
}

// Modal + maintenance wiring
if (!content.includes("handleListBoardModal(interaction)")) {
  content = content.replace(
    'client.on("interactionCreate", async (interaction) => {\n  if (!interaction.isButton()) return;',
    `client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isModalSubmit() && isListBoardModal(interaction.customId)) {
      await handleListBoardModal(interaction);
      return;
    }
  } catch (error) {
    console.error("List board modal failed.", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Impossible de traiter le formulaire.", ephemeral: true }).catch(() => undefined);
    }
    return;
  }
  if (!interaction.isButton()) return;`,
  );
}

if (!content.includes("processOpsMaintenance({")) {
  const maintNeedle = `  if (settings?.retentionDays) {
    const cutoff = new Date(now - settings.retentionDays * 24 * 60 * 60 * 1_000);
    const deleted = await deleteRetainedRequests(HOME_GUILD_ID, cutoff);
    if (deleted > 0) console.info(\`Removed \${deleted} closed request(s) due to configured retention.\`);
  }
}`;
  const maintReplace = `  if (settings?.retentionDays) {
    const cutoff = new Date(now - settings.retentionDays * 24 * 60 * 60 * 1_000);
    const deleted = await deleteRetainedRequests(HOME_GUILD_ID, cutoff);
    if (deleted > 0) console.info(\`Removed \${deleted} closed request(s) due to configured retention.\`);
  }

  try {
    await processOpsMaintenance({
      client,
      guildId: HOME_GUILD_ID,
      botUserId: client.user?.id ?? OWNER_ID,
      postInRequestThread: async (request, content, pingUserIds = []) => {
        const thread = await fetchThread(request.threadId);
        if (!thread) return;
        if (thread.archived) await thread.setArchived(false).catch(() => undefined);
        const mentions = pingUserIds.map((id) => \`<@\${id}>\`).join(" ");
        await thread.send({
          content: (mentions ? mentions + "\\n" : "") + content,
          allowedMentions: { users: pingUserIds },
        });
      },
      notifyMember: async (request, content) => {
        await notifyMember(request as any, content);
      },
    });
  } catch (error) {
    console.error("Ops maintenance (nudges) failed.", error);
  }
}`;
  if (content.includes(maintNeedle)) {
    content = content.replace(maintNeedle, maintReplace);
  } else {
    console.warn("WARN: processMaintenance end not found for ops injection");
  }
}

if (!content.includes("handleListBoardModal,")) {
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

if (!content.includes("postRequestUpdate:")) {
  content = content.replace(
    "startListBoard(client, HOME_GUILD_ID);",
    `startListBoard(client, HOME_GUILD_ID, {
    isStaff: async (userId) => {
      try {
        const guild = await client.guilds.fetch(HOME_GUILD_ID);
        const member = await guild.members.fetch(userId);
        const fakeMessage = { author: { id: userId }, member, guild } as any;
        return isAuthorized(fakeMessage, "!ask");
      } catch {
        return userId === OWNER_ID;
      }
    },
    postRequestUpdate: async (request, text) => {
      const full = await findRequestById(HOME_GUILD_ID, request.id);
      if (full) await postRequestUpdate(full, text);
    },
  });`,
  );
}

writeFileSync(outFile, content);
console.log(
  `Assembled ${outFile} (${content.length} bytes) from ${files.length} compressed parts (moderation stripped, ops injected).`,
);
console.log("Has ops-commands import:", content.includes("ops-commands.js"));
console.log("Has !find handler:", content.includes('command === "!find"'));
console.log("Has !healthcheck help:", content.includes("!healthcheck"));
console.log("Has recordGroqCall:", content.includes("recordGroqCall"));
