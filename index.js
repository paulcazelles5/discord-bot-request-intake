/**
 * Spaceify / Pterodactyl entrypoint.
 * Startup is fixed to: node /home/container/index.js
 *
 * Handles both layouts:
 *   A) files at /home/container/ (package.json here)
 *   B) GitHub ZIP nested: /home/container/discord-bot-request-intake-*/
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true,
    cwd: opts.cwd || root,
    env: process.env,
    ...opts,
  });
  return r.status === null ? 1 : r.status;
}

function findAppDir() {
  // Layout A: package.json already at root
  if (fs.existsSync(path.join(root, "package.json")) && fs.existsSync(path.join(root, "scripts"))) {
    return root;
  }
  // Layout B: one nested folder that contains the bot
  const names = fs.readdirSync(root);
  for (const name of names) {
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      if (
        fs.existsSync(path.join(full, "package.json")) &&
        fs.existsSync(path.join(full, "scripts"))
      ) {
        return full;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function ensurePnpm() {
  const v = spawnSync("pnpm", ["-v"], { shell: true, stdio: "ignore" });
  if (v.status === 0) return true;
  console.log("[boot] Installing pnpm...");
  const code = run("npm", ["install", "-g", "pnpm@10.28.0"]);
  return code === 0;
}

function main() {
  const appDir = findAppDir();
  if (!appDir) {
    console.error("[boot] Bot files not found under", root);
    console.error("[boot] Expected package.json + scripts/ here or in one subfolder.");
    process.exit(1);
  }
  console.log("[boot] App directory:", appDir);

  if (!ensurePnpm()) {
    console.error("[boot] pnpm install failed");
    process.exit(1);
  }

  if (!fs.existsSync(path.join(appDir, "node_modules"))) {
    console.log("[boot] Installing dependencies...");
    const code = run(
      "pnpm",
      ["install", "--filter", "@workspace/scripts...", "--filter", "@workspace/db...", "--no-frozen-lockfile"],
      { cwd: appDir },
    );
    if (code !== 0) {
      console.error("[boot] pnpm install failed");
      process.exit(code);
    }
  }

  // Optional schema push on fresh Neon DB (ignore failure)
  run("pnpm", ["--filter", "@workspace/db", "run", "push-force"], { cwd: appDir });

  console.log("[boot] Starting Discord bot...");
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/scripts", "run", "discord-bot"],
    {
      cwd: appDir,
      stdio: "inherit",
      shell: true,
      env: process.env,
    },
  );

  const stop = (sig) => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

main();
