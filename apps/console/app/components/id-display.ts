/**
 * Names-over-ids formatting helpers (#1283). A raw id should never render as
 * visible text on its own — either resolve it to a human name, or show a
 * short hash with the full id available via a `title` tooltip / copy
 * affordance (see `./copy-id.tsx`).
 */

/** Truncates `id` to its leading `visibleChars` characters + an ellipsis.
 * Ids already at or under that length pass through unchanged. */
export function shortId(id: string, visibleChars = 8): string {
  return id.length > visibleChars ? `${id.slice(0, visibleChars)}…` : id;
}

/** Prefers a resolved human `name`; falls back to a short hash of `id` with
 * the full id carried in `title` for a hover tooltip. Never returns the
 * full raw id as the display `text`. */
export function nameOrShortId(
  name: string | null | undefined,
  id: string,
  visibleChars = 8
): { text: string; title?: string } {
  if (name) return { text: name };
  return { text: shortId(id, visibleChars), title: id };
}
