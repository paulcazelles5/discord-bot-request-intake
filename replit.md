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
- `scripts/README.discord-bot.md` — Discord Developer Portal and channel setup notes.

## Architecture decisions

- The bot uses Discord Gateway via `discord.js`; the Replit Discord account connector does not run bot gateway clients.
- Bot credentials are configured through Replit Secrets and are never requested from server members.

## Product

- `!help` lists the bot's commands.
- `!request` collects a feature description in DMs, posts it to `・requests`, then collects non-secret setup details and posts them to `・data`.

## User preferences

- All bot messages and commands should be in English.

## Gotchas

- Enable the Message Content Intent in the Discord Developer Portal.
- Keep `・data` restricted to staff. Members must never submit bot tokens, API keys, passwords, client secrets, or other credentials.
- Active request conversations are held in memory and are lost if the bot process restarts before the member finishes.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
