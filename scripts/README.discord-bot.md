# Discord request bot setup

The bot supports `!help`, `!request`, `!history`, `!log`, and `!ask` in guild `1499704751481294878` only. Its responses and DMs are in English.

## Discord setup

1. Create a bot application in the Discord Developer Portal and add its bot user to the target server.
2. In **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Give the bot View Channel, Send Messages, and Read Message History in `・requests` and `・data`.
4. Restrict `・data` and any channel selected with `!log` to staff. The bot only posts non-secret request metadata or setup replies there.
5. Add this request bot's token to this Replit project as the `DISCORD_BOT_TOKEN` secret. Never paste it into Discord, source files, or chat.

For bots requested by members, the member must add that bot's token—and an OAuth2 client secret only if their bot needs OAuth2—to the secret manager of their own hosting project. Staff provide the code and setup instructions; they do not receive these values.

## Request flow

- A member runs `!request` in the target server.
- If staff configured a log channel with `!log #channel`, the bot posts the member's username, user ID, command time, and command channel there. It does not log DM content.
- The bot DMs them for a feature description and posts the response to `・requests`.
- The bot then asks for non-secret setup information, such as an application/client ID, permissions, intents, preferred library, and hosting needs.
- That second response is posted to `・data`, with a link to the original request.
- Messages that look like credentials are rejected and are not relayed. Members should delete any accidentally sent credentials from their DM.
- The member configures their own requested bot's credentials in their hosting provider's private secrets after receiving the code.

The bot does not retain or persist pending conversations. If it restarts mid-request, the member can start again with `!request`.

## Staff commands

These commands require the Discord **Manage Server** permission and only work in the target server:

- `!history` — DM the staff member links to the 20 latest requests in `・requests`.
- `!log #channel` — set the destination for `!request` activity logs. Accepts a channel mention or channel ID. The selected channel ID is saved in the local, non-secret `scripts/discord-bot-config.json` file and survives workflow restarts.
- `!ask @user <question>` — DM a custom follow-up question to a member. Their non-secret reply is sent to `・data`. This is rejected if they already have an active request DM flow.
