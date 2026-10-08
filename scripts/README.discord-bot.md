# Discord request bot setup

The bot supports `!help` and `!request` in guild `1499704751481294878` only. Its responses and DMs are in English.

## Discord setup

1. Create a bot application in the Discord Developer Portal and add its bot user to the target server.
2. In **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. Give the bot access to the exact text channels `・requests` and `・data`, with permission to view and send messages.
4. Restrict `・data` to staff. It receives only non-secret setup notes.
5. Add this request bot's token to this Replit project as the `DISCORD_BOT_TOKEN` secret. Never paste it into Discord, source files, or chat.

For bots requested by members, the member must add that bot's token—and an OAuth2 client secret only if their bot needs OAuth2—to the secret manager of their own hosting project. Staff provide the code and setup instructions; they do not receive these values.

## Request flow

- A member runs `!request` in the target server.
- The bot DMs them for a feature description and posts the response to `・requests`.
- The bot then asks for non-secret setup information, such as an application/client ID, permissions, intents, preferred library, and hosting needs.
- That second response is posted to `・data`, with a link to the original request.
- Messages that look like credentials are rejected and are not relayed. Members should delete any accidentally sent credentials from their DM.
- The member configures their own requested bot's credentials in their hosting provider's private secrets after receiving the code.

The bot does not retain or persist pending conversations. If it restarts mid-request, the member can start again with `!request`.
