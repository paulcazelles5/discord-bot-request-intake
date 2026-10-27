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
// Remove the whole Utilities help block cleanly
content = content.replace(
  /\s*"\*\*Utilities\*\* \(requires the corresponding Discord moderation permission\)\\n" \+\n\s*"`!ban[^"]*" \+\n\s*"`!mute[^"]*" \+\n\s*"`!clear[^"]*" \+\n/,
  "\n    ",
);
// Also drop any leftover ban/mute lines if the above didn't match exactly
content = content.replace(
  /\s*"`!ban[^`]*`\s*,\s*`!unban[^`]*`\s*,\s*`!kick[^`]*`\\n" \+\n\s*"`!mute[^"]*" \+\n\s*"`!clear[^"]*" \+\n/g,
  "\n    ",
);

// --- Inject ops-commands ---
const OPS_IMPORT = `import {
  handleFindCommand,
  handleHealthcheckCommand,
  handleMyRequestsCommand,
  handleStatsCommand,
  recordGroqCall,
} from "./ops-commands.js";
`;

if (!content.includes('from "./ops-commands.js"')) {
  content = content.replace(
    /(from\s*["']\.\/list-board\.js["']\s*;\s*)/,
    `$1\n${OPS_IMPORT}`,
  );
}

// Inject handlers into handleGuildCommand after help
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

// Help text: add ops section before Owner only
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

// Instrument Groq call with recordGroqCall
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

writeFileSync(outFile, content);
console.log(
  `Assembled ${outFile} (${content.length} bytes) from ${files.length} compressed parts (moderation stripped, ops injected).`,
);
console.log("Has ops-commands import:", content.includes("ops-commands.js"));
console.log("Has !find handler:", content.includes('command === "!find"'));
console.log("Has !healthcheck help:", content.includes("!healthcheck"));
console.log("Has recordGroqCall:", content.includes("recordGroqCall"));
