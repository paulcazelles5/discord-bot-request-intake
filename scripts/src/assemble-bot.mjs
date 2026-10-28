#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parts = readdirSync(__dirname)
  .filter((f) => /^assemble-fix-\d+\.b64$/.test(f))
  .sort();
if (!parts.length) {
  console.error("Missing assemble-fix-*.b64 payload files");
  process.exit(1);
}
const b64 = parts.map((f) => readFileSync(join(__dirname, f), "utf8").replace(/\s+/g, "")).join("");
const code = Buffer.from(b64, "base64").toString("utf8");
if (!code.includes("inflateSync") || code.includes("PLACEHOLDER")) {
  console.error("Invalid assemble-fix payload");
  process.exit(1);
}
const out = join(__dirname, "_assemble_fixed_runtime.mjs");
writeFileSync(out, code);
await import(pathToFileURL(out).href);
