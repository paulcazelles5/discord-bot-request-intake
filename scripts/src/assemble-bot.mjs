#!/usr/bin/env node
/**
 * Downloads the known-good assembler, applies crash fixes, then runs it.
 * Fixes: bare try{} in generateBotCodeWithGroq, missing modal imports, login-before-DB.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_COMMIT = "23434304479f46fcc61298d9ec075069165f712f";
const RAW_URL = `https://raw.githubusercontent.com/paulcazelles5/discord-bot-request-intake/${GOOD_COMMIT}/scripts/src/assemble-bot.mjs`;
const cachePath = join(__dirname, "_assemble_cached.mjs");
const fixedPath = join(__dirname, "_assemble_fixed.mjs");

function applyCrashFixes(src) {
  // 1) Replace broken Groq instrumentation with a safe version
  const groqStart = src.indexOf("// Instrument Groq call with recordGroqCall");
  const groqEnd = src.indexOf("// --- Final wiring: modal + ops maintenance");
  if (groqStart >= 0 && groqEnd > groqStart) {
    const safeGroq = `
// Instrument Groq call with recordGroqCall (safe — never leave a bare try)
if (!content.includes("recordGroqCall({")) {
  const openRe =
    /async function generateBotCodeWithGroq\\(description: string\\): Promise<string> \\{\\n  if \\(!GROQ_API_KEY\\) \\{\\n    throw new Error\\("GROQ_API_KEY secret is not configured\\."\\);\\n  }\\n/;
  if (openRe.test(content)) {
    content = content.replace(
      openRe,
      \`async function generateBotCodeWithGroq(description: string): Promise<string> {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY secret is not configured.");
  }
  const t0 = Date.now();
  let ok = false;
  let errMsg: string | undefined;
  try {
\`,
    );
  }

  const stripIdx = content.indexOf("// Strip accidental markdown fences if the model still adds them");
  if (stripIdx >= 0) {
    const fnEnd = content.indexOf("\\n}\\n\\nasync function handleAiCreateCommand", stripIdx);
    if (fnEnd > stripIdx) {
      content =
        content.slice(0, stripIdx) +
        \`// Strip accidental markdown fences if the model still adds them
  ok = true;
  return content
    .replace(/^\\\\`\\\\`\\\\`(?:js|javascript)?\\n?/i, "")
    .replace(/\\n?\\\\`\\\\`\\\\`$/i, "")
    .trim();
  } catch (e) {
    errMsg = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    recordGroqCall({ ok, latencyMs: Date.now() - t0, error: errMsg });
  }
}\` +
        content.slice(fnEnd + 1);
    }
  }
}

`;
    src = src.slice(0, groqStart) + safeGroq + src.slice(groqEnd);
  }

  // 2) Before writeFileSync: inject modal imports, boot order, safety strip
  const marker = "writeFileSync(outFile, content);";
  if (src.includes(marker) && !src.includes("Patched boot: login before")) {
    const inject = `
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

// Login before DB
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
    console.log("Patched boot (regex): login before verifyStoreReady.");
  }
}

// Safety: strip incomplete Groq try if still present
{
  const fnStart = content.indexOf("async function generateBotCodeWithGroq");
  const fnNext = content.indexOf("\\nasync function handleAiCreateCommand", fnStart);
  if (fnStart >= 0 && fnNext > fnStart) {
    const fn = content.slice(fnStart, fnNext);
    if (fn.includes("let ok = false") && !fn.includes("finally {")) {
      console.warn("WARN: incomplete Groq try instrumentation — removing it");
      let fixed = fn
        .replace(/\\n  const t0 = Date\\.now\\(\\);\\n  let ok = false;\\n  let errMsg: string \\| undefined;\\n  try \\{\\n/, "\\n")
        .replace(/\\n  ok = true;\\n  return content/, "\\n  return content");
      content = content.slice(0, fnStart) + fixed + content.slice(fnNext);
    }
  }
}

`;
    src = src.replace(marker, inject + marker);
  }
  return src;
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
    if (!res.ok) throw new Error(`Failed to download assembler: HTTP ${res.status}`);
    code = await res.text();
    if (!code.includes("inflateSync") || code.includes("PLACEHOLDER")) {
      throw new Error("Downloaded assembler looks invalid");
    }
    writeFileSync(cachePath, code);
  }
  const fixed = applyCrashFixes(code);
  writeFileSync(fixedPath, fixed);
  await import(pathToFileURL(fixedPath).href);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
