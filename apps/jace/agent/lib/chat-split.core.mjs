// Pure text splitter for Jace's chat channels (Telegram, Slack, Discord).
//
// Eve's Telegram `post()` already splits text that exceeds the Bot API's
// 4096-character limit (see `splitTelegramMessageText` in
// eve/channels/telegram), but that split is a byte-length safety net, not a
// human-cadence feature — an ordinary short/medium reply is always sent as a
// single bubble. To make Jace read like someone actually texting, this module
// splits on the model's OWN paragraph breaks (a blank line): instructions.md
// tells the model a blank line separates distinct thoughts into distinct
// messages, so this is just honoring that separator, not inventing one.
//
// Pure and dependency-free so it's unit-testable without booting Eve. Lives
// under agent/lib/, which Eve does not load as a tool/channel.

const DEFAULT_MAX_MESSAGES = 3;

/**
 * Split `text` into 1..maxMessages chat bubbles on blank-line paragraph
 * breaks. Overflow beyond `maxMessages` is folded into the final bubble
 * (rejoined with a blank line) rather than dropped, so no content is ever
 * lost — just recombined.
 *
 * @param {string} text
 * @param {{ maxMessages?: number }} [opts]
 * @returns {string[]} always exactly one element for empty/single-paragraph input
 */
export function splitIntoChatMessages(text, opts = {}) {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  if (typeof text !== "string" || text.trim() === "") return [text];

  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");

  if (paragraphs.length <= 1) return [text.trim()];
  if (paragraphs.length <= maxMessages) return paragraphs;

  const head = paragraphs.slice(0, maxMessages - 1);
  const overflow = paragraphs.slice(maxMessages - 1).join("\n\n");
  return [...head, overflow];
}
