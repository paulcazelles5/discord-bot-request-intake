import type { Message } from "discord.js";

/** Moderation utility commands have been removed. */
export function isUtilityCommand(_command: string): boolean {
  return false;
}

export async function handleUtilityCommand(
  _message: Message,
  _args: string[],
  _command: string,
): Promise<void> {
  // no-op: moderation commands disabled
}
