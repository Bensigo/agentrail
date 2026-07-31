/**
 * A Discord channel name is capped at 100 characters, and a thread's name is
 * the first thing anyone scanning the channel sees — so it is derived from the
 * user's own words rather than something generic.
 *
 * The text handed in is already mention-stripped (the Gateway removes the
 * bot's own `<@id>` token before the message ever reaches the console), so
 * this only has to normalize whitespace and fit the limit.
 */
const MAX_THREAD_NAME = 100;
const FALLBACK = "Jace";

export function deriveThreadName(text: string): string {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!flat) return FALLBACK;
  if (flat.length <= MAX_THREAD_NAME) return flat;
  const cut = flat.slice(0, MAX_THREAD_NAME);
  const lastSpace = cut.lastIndexOf(" ");
  // A single unbroken token longer than the limit has no boundary to cut on —
  // hard-cut rather than fall back, so the name still carries the user's text.
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}
