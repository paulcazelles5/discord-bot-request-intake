#!/usr/bin/env node
/**
 * Crash-safe assembler:
 * 1) Load known-good assemble-bot from commit 2343430 (or cache)
 * 2) Disable broken Groq instrumentation entirely (was leaving a bare try{})
 * 3) Inject modal imports + login-before-DB + English-only strings before writeFileSync
 * 4) Run
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_COMMIT = "23434304479f46fcc61298d9ec075069165f712f";
const RAW_URL = `https://raw.githubusercontent.com/paulcazelles5/discord-bot-request-intake/${GOOD_COMMIT}/scripts/src/assemble-bot.mjs`;
const cachePath = join(__dirname, "_assemble_cached.mjs");
const runPath = join(__dirname, "_assemble_runtime.mjs");

function fix(src) {
  // Disable the broken Groq instrumentation block completely
  const a = src.indexOf("// Instrument Groq call with recordGroqCall");
  const b = src.indexOf("// --- Final wiring: modal + ops maintenance");
  if (a >= 0 && b > a) {
    src =
      src.slice(0, a) +
      "// Groq instrumentation disabled (previous version left a bare try{} and crashed the bot)\n\n" +
      src.slice(b);
  }

  const marker = "writeFileSync(outFile, content);";
  if (!src.includes(marker)) return src;
  if (src.includes("CRASH_FIXES_APPLIED")) return src;

  const inject = `
// CRASH_FIXES_APPLIED
// Modal imports
if ((content.includes("isListBoardModal(") || content.includes("handleListBoardModal(")) &&
    (!/handleListBoardModal\\s*,/.test(content) || !/isListBoardModal\\s*,/.test(content))) {
  content = content.replace(
    /import\\s*\\{\\s*handleListBoardButton,\\s*isListBoardButton,\\s*notifyListBoardChanged,\\s*startListBoard,\\s*\\}\\s*from\\s*["']\\.\\/list-board\\.js["']\\s*;/,
    \`import {
  handleListBoardButton,
  handleListBoardModal,
  isListBoardButton,
  isListBoardModal,
  notifyListBoardChanged,
  startListBoard,
} from "./list-board.js";\`,
  );
}

// Login before DB check
{
  const oldBoot = "await verifyStoreReady();\\nawait client.login(BOT_TOKEN);";
  const newBoot = \`await client.login(BOT_TOKEN);
try {
  await verifyStoreReady();
  console.info("Request store (database) is ready.");
} catch (err) {
  console.error(
    "WARNING: Database not ready after login. Bot is ONLINE but requests need DATABASE_URL.",
    err instanceof Error ? err.message : err,
  );
}\`;
  if (content.includes(oldBoot)) {
    content = content.replace(oldBoot, newBoot);
    console.log("Patched boot: login before verifyStoreReady.");
  } else if (/await verifyStoreReady\\(\\);\\s*\\n\\s*await client\\.login\\(BOT_TOKEN\\);/.test(content)) {
    content = content.replace(/await verifyStoreReady\\(\\);\\s*\\n\\s*await client\\.login\\(BOT_TOKEN\\);/, newBoot);
    console.log("Patched boot (regex).");
  }
}

// English-only private thread welcome (was French)
{
  content = content.replaceAll(
    "Discussion privée pour",
    "Private discussion for",
  );
  content = content.replaceAll(
    "tu as accès à ce thread uniquement",
    "you only have access to this thread",
  );
}

// Final safety: if any incomplete try remains in generateBotCodeWithGroq, strip it
{
  const fnStart = content.indexOf("async function generateBotCodeWithGroq");
  const fnNext = content.indexOf("\\nasync function handleAiCreateCommand", fnStart);
  if (fnStart >= 0 && fnNext > fnStart) {
    const fn = content.slice(fnStart, fnNext);
    if ((fn.match(/\\btry\\s*\\{/g) || []).length > (fn.match(/\\bfinally\\s*\\{/g) || []).length) {
      console.warn("WARN: stripping incomplete try in generateBotCodeWithGroq");
      let fixed = fn
        .replace(/\\n  const t0 = Date\\.now\\(\\);\\n  let ok = false;\\n  let errMsg: string \\| undefined;\\n  try \\{\\n/, "\\n")
        .replace(/\\n  ok = true;\\n  return content/, "\\n  return content");
      content = content.slice(0, fnStart) + fixed + content.slice(fnNext);
    }
  }
}

`;
  return src.replace(marker, inject + marker);
}

async function main() {
  let code;
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8");
    if (cached.includes("inflateSync") && !cached.includes("PLACEHOLDER")) code = cached;
  }
  if (!code) {
    console.log("Downloading known-good assemble-bot from", GOOD_COMMIT);
    const res = await fetch(RAW_URL);
    if (!res.ok) throw new Error("Failed to download assembler: HTTP " + res.status);
    code = await res.text();
    if (!code.includes("inflateSync") || code.includes("PLACEHOLDER")) {
      throw new Error("Downloaded assembler looks invalid");
    }
    writeFileSync(cachePath, code);
  }
  const fixed = fix(code);
  writeFileSync(runPath, fixed);
  await import(pathToFileURL(runPath).href);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
