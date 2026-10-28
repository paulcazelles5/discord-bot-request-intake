#!/usr/bin/env node
/**
 * Bootstrap: restore the real assembler from a known-good commit, then run it.
 * Avoids the broken PLACEHOLDER that was briefly on main.
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOOD_COMMIT = "23434304479f46fcc61298d9ec075069165f712f";
const RAW_URL = `https://raw.githubusercontent.com/paulcazelles5/discord-bot-request-intake/${GOOD_COMMIT}/scripts/src/assemble-bot.mjs`;
const cachePath = join(__dirname, "_assemble_cached.mjs");

async function main() {
  let code;
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath, "utf8");
    if (cached.includes("inflateSync") && !cached.includes("PLACEHOLDER")) {
      code = cached;
    }
  }
  if (!code) {
    console.log("Downloading known-good assemble-bot from", GOOD_COMMIT);
    const res = await fetch(RAW_URL);
    if (!res.ok) {
      throw new Error(`Failed to download assembler: HTTP ${res.status}`);
    }
    code = await res.text();
    if (!code.includes("inflateSync") || code.includes("PLACEHOLDER")) {
      throw new Error("Downloaded assembler looks invalid");
    }
    writeFileSync(cachePath, code);
  }
  const runPath = join(__dirname, "_assemble_runtime.mjs");
  writeFileSync(runPath, code);
  await import(pathToFileURL(runPath).href);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
