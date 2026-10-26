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

const b64 = files.map((f) => readFileSync(join(partsDir, f), "utf8")).join("");
const compressed = Buffer.from(b64, "base64");
const content = inflateSync(compressed).toString("utf8");
writeFileSync(outFile, content);
console.log(`Assembled ${outFile} (${content.length} bytes) from ${files.length} compressed parts.`);
