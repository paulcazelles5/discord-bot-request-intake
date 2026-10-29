/**
 * Entry point for panels that force: node /home/container/index.js
 * (Spaceify / Pterodactyl-style hosts)
 *
 * Boots the Discord request bot via the existing pnpm workspace script.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true,
    cwd: root,
    env: process.env,
    ...opts,
  });
  return result.status === null ? 1 : result.status;
}

function hasPnpm() {
  return run("pnpm", ["-v"], { stdio: "ignore" }) === 0;
}

function ensurePnpm() {
  if (hasPnpm()) return true;
  console.log("[boot] pnpm not found, installing globally...");
  const code = run("npm", ["install", "-g", "pnpm"]);
  if (code !== 0) {
    console.error("[boot] Failed to install pnpm. Install it manually then restart.");
    return false;
  }
  return hasPnpm();
}

function ensureDeps() {
  const marker = path.join(root, "node_modules");
  if (fs.existsSync(marker)) {
    console.log("[boot] node_modules present, skipping install");
    return 0;
  }
  console.log("[boot] Installing dependencies with pnpm...");
  return run("pnpm", ["install"]);
}

function startBot() {
  console.log("[boot] Starting Discord bot (pnpm --filter @workspace/scripts run discord-bot)...");
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/scripts", "run", "discord-bot"],
    {
      stdio: "inherit",
      shell: true,
      cwd: root,
      env: process.env,
    },
  );

  const shutdown = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[boot] Bot exited from signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

(async function main() {
  try {
    if (!ensurePnpm()) process.exit(1);

    const installCode = ensureDeps();
    if (installCode !== 0) {
      console.error("[boot] pnpm install failed");
      process.exit(installCode);
    }

    startBot();
  } catch (err) {
    console.error("[boot] Fatal error:", err);
    process.exit(1);
  }
})();
