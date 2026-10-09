# Discord Bot Request Intake

A Discord bot for an English-speaking server where members submit bot-build requests to a staff team.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run discord-bot` — run the Discord request bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret for the bot: `DISCORD_BOT_TOKEN`
- The bot only handles commands and request DMs for guild `1499704751481294878`.
- Required staff channels: `・requests` and `・data`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `scripts/src/discord-bot.ts` — Discord bot commands and the two-step request intake flow.
- `scripts/src/request-store.ts` — persistent request, permission, settings, and audit operations.
- `scripts/README.discord-bot.md` — Discord Developer Portal and channel setup notes.

## Architecture decisions

- The bot uses Discord Gateway via `discord.js`; the Replit Discord account connector does not run bot gateway clients.
- The intake bot's token is stored in Replit Secrets. Members configure credentials for their own requested bots in their own hosting secret manager; those values are never requested or relayed by this bot.
- Request records, follow-ups, per-user command grants, delegated owner access, the `!log` destination, and retention settings are stored in the existing PostgreSQL database.
- The owner ID `1264183250243420211` has all bot-command access. Only this primary owner can use `!owner <user-id>` to delegate every command except `!owner`; `!perm` grants narrower staff access. Discord roles and server permissions do not grant bot commands.

## Product

- `!help` lists public and staff commands.
- `!request` collects a feature description in DMs, posts it to `・requests`, then collects non-secret setup details and posts them to `・data`.
- Staff commands are gated by the owner ID and persistent per-user grants. They include `!history`, `!log`, `!ask`, `!status`, `!assign`, `!reopen`, `!export`, `!backup`, and `!retention`.
- `!owner <user-id>` is reserved to the primary owner and delegates all commands except `!owner`.

## User preferences

- All bot messages and commands should be in English.

## Gotchas

- Enable the Message Content Intent in the Discord Developer Portal.
- Keep `・data` restricted to staff. Members must never submit bot tokens, API keys, passwords, client secrets, or other credentials.
- Request intake and follow-up state survives bot restarts in PostgreSQL.
- Automatic data deletion is off by default; the owner can opt in with `!retention <days>`.
- Create Public Threads and Send Messages in Threads are needed for request discussion threads. If unavailable, the request remains in `・requests` without a thread.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
