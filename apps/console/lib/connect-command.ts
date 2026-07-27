/**
 * Pure recognition + decision for the in-chat `/connect` command.
 *
 * Handled in the console dispatcher BEFORE workspace resolution, so it works
 * on exactly the conversations that are broken (no jace_sessions row needed)
 * and never reaches the model — recognition is exact string matching, not
 * classification. See docs/superpowers/specs/2026-07-27-jace-connect-command-design.md.
 */

const COMMAND = "/connect";

/** Discord guild messages arrive mention-prefixed: `<@123> /connect`. */
const LEADING_MENTION = /^<@!?\d+>\s*/;

/**
 * Recognize `/connect [workspace]`. The token must be FIRST — a message that
 * merely contains "/connect" is a normal message and reaches Jace unchanged.
 * A trailing `@botname` (Telegram groups) is stripped from the token only.
 */
export function parseConnectCommand(text: string): {
  isCommand: boolean;
  arg: string;
} {
  const stripped = String(text ?? "").trim().replace(LEADING_MENTION, "");
  if (!stripped) return { isCommand: false, arg: "" };

  const firstSpace = stripped.search(/\s/);
  const rawToken = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
  const token = rawToken.split("@")[0]!.toLowerCase();
  if (token !== COMMAND) return { isCommand: false, arg: "" };

  const arg = firstSpace === -1 ? "" : stripped.slice(firstSpace).trim();
  return { isCommand: true, arg };
}
