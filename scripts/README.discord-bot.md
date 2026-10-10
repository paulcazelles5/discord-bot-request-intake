# Discord request bot

The bot's messages are in English and it handles commands only in guild `1499704751481294878`. Request intake and command permissions are saved in the Replit PostgreSQL database.

## Discord setup

1. Add the bot to the target server and enable **Message Content Intent** in the Discord Developer Portal.
2. In `・requests` and `・data`, allow the bot to view the channel, send messages, read message history, and attach files.
3. In `・requests`, also allow **Create Public Threads** and **Send Messages in Threads** so each request can have a staff discussion thread. The request itself is still posted if thread creation fails.
4. Restrict `・requests`, `・data`, and the selected `!log` channel to staff. The bot's own command permissions do not grant access to Discord channels.
5. Add the bot's own token to this Replit project as the `DISCORD_BOT_TOKEN` secret. Never paste that token into Discord, source files, or chat.

Members configure credentials for their requested bots themselves in the private secrets manager of their own hosting project. This bot never asks for or forwards tokens, passwords, API keys, OAuth client secrets, or other secrets.

## Member commands and request flow

- `!help` — show the command list.
- `!request` — start one request at a time in DMs. A member can start up to three requests per 24 hours.
- `!resume` — resend the current unanswered DM question.
- `!cancel` — cancel the member's own open request.

The bot asks for a feature description and posts it to `・requests`, then asks for non-secret setup details and posts them to `・data`. Members may attach up to three PNG, JPG, or WebP reference images.

Each request has a persistent ID such as `REQ-00001`, a status, timestamps, an optional assignee, a staff thread, follow-ups, and an event history. If a member is expected to reply, the bot sends reminders after 48 hours and expires the request after 14 days without a reply.

## Staff and owner commands

Only Discord user ID `1264183250243420211` has automatic staff access. Server roles and the Manage Server permission do not grant bot command access. The owner can grant access to individual users using `!perm` or `!owner`.

- `!owner 123456789012345678` — grant all bot commands except `!owner`. Only the primary owner can grant this access; delegated owners cannot add other owners.
- `!perm !history 123456789012345678` — grant one staff command.
- `!perm all 123456789012345678` — grant all staff commands.
- `!unperm !history 123456789012345678` — block/revoke one command (also overrides an `all` grant).
- `!unperm all 123456789012345678` — remove all grants and overrides.
- `!perm list [@user]` — view saved grants and overrides.

Delegated owners can run every command other than `!owner`, including `!perm` and `!unperm`. Owner delegations are saved separately from staff-command grants.

Available staff commands:

- `!history [page] [status] [user-id]` — DM 20 requests per page; optionally filter by status or member ID.
- `!log #channel` — save the channel for `!request` metadata logs.
- `!ask @user <question>` — send a custom follow-up DM about the member's current request; the non-secret answer is sent to `・data`.
- `!code @user` with one attached file (up to 25 MB) — DM the file and request summary to the member, mark their fully submitted open request completed, and tell them setup instructions are in the README file. The bot also confirms the file was sent and tells the user to contact the staff if they run into any issues.
- `!status REQ-ID received|accepted|in-progress|completed|declined [note]` — update status and notify the member.
- `!assign REQ-ID @staff-member` — assign a request and notify the assignee.
- `!reopen REQ-ID` — reopen a closed request.
- `!export REQ-ID` — DM a text export of one request.
- `!backup` — DM the request data as a JSON backup.
- `!retention` — show the current closed-request retention setting.
- `!retention <1-3650|off>` — automatically delete closed requests and related records after the selected number of days, or turn automatic deletion off.

Automatic deletion is **off by default**. Open requests are never removed by this retention setting. `!backup` and `!export` contain request data and should be kept private.

The bot's minimum channel permissions still apply even to the owner and users granted commands. Keep the workflow running for the bot to receive events; reconnects and request-state recovery are handled automatically.

