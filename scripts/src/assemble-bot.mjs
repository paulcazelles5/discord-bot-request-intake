#!/usr/bin/env node
/**
 * Restored assemble entry: loads split source parts then runs the real assembler.
 * (Recovered after a bad PLACEHOLDER push.)
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const partA = join(__dirname, "assemble-part-a.mjs.txt");
const partB = join(__dirname, "assemble-part-b.mjs.txt");

if (!existsSync(partA) || !existsSync(partB)) {
  console.error("Missing assemble-part-a/b.mjs.txt — cannot assemble the bot.");
  process.exit(1);
}

const code = readFileSync(partA, "utf8") + readFileSync(partB, "utf8");
const tmp = join(__dirname, "_assemble_runtime.mjs");
writeFileSync(tmp, code);
await import(pathToFileURL(tmp).href);
