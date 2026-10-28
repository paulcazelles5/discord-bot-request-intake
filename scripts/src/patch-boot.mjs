#!/usr/bin/env node
/**
 * Post-assemble patch: Discord login BEFORE database check.
 * Without this, a missing/slow DATABASE_URL prevents client.login() and the bot stays offline.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, "discord-bot.ts");

let src = readFileSync(target, "utf8");

const oldBoot = "await verifyStoreReady();\nawait client.login(BOT_TOKEN);";
const newBoot = `await client.login(BOT_TOKEN);
try {
  await verifyStoreReady();
  console.info("Request store (database) is ready.");
} catch (err) {
  console.error(
    "WARNING: Database not ready after login. Bot is ONLINE but requests need DATABASE_URL.",
    err instanceof Error ? err.message : err,
  );
}`;

if (src.includes(oldBoot)) {
  src = src.replace(oldBoot, newBoot);
  writeFileSync(target, src);
  console.log("patch-boot: login-before-DB applied.");
} else if (/await verifyStoreReady\(\);\s*\n\s*await client\.login\(BOT_TOKEN\);/.test(src)) {
  src = src.replace(
    /await verifyStoreReady\(\);\s*\n\s*await client\.login\(BOT_TOKEN\);/,
    newBoot,
  );
  writeFileSync(target, src);
  console.log("patch-boot: login-before-DB applied (regex).");
} else if (src.includes("await client.login(BOT_TOKEN)") && src.indexOf("await client.login") < src.indexOf("await verifyStoreReady")) {
  console.log("patch-boot: already in correct order, nothing to do.");
} else {
  console.warn("patch-boot: boot block not found — check discord-bot.ts after assemble.");
}
