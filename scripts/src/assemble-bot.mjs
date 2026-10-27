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
  /\s*"\*\*Utilities\*\*[^"]*"\s*\+\s*\n(?:\s*"[^"]*"\s*\+\s*\n){0,6}/g,
  "",
);
content = content.replace(
  /\s*`!ban[^`]*`\s*,\s*`!unban[^`]*`\s*,\s*`!kick[^`]*`\s*\n?\s*`!mute[^`]*`[^\n]*\n?\s*`!clear[^`]*`[^\n]*\n?/g,
  "",
);

writeFileSync(outFile, content);
console.log(
  `Assembled ${outFile} (${content.length} bytes) from ${files.length} compressed parts (moderation stripped).`,
);
