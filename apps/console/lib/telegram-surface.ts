import type { CSSProperties } from "react";

/** Telegram-look tokens for the landing's phone demo, matched to the
 *  owner's REAL iOS screenshot of the Jace bot chat (2026-07-22): the
 *  green gradient wallpaper, iOS light-green outgoing bubbles, green read
 *  checks, the translucent date pill, and the inline-keyboard/link blue.
 *  Hex values live HERE — a token file outside the pinned marketing
 *  components (same pattern as `light-surface.ts`) — so `_phone-demo.tsx`
 *  / `_conversation-demo.tsx` stay hex-free and consume `var(--tg-*)`
 *  classes only. Familiar chrome, not a pixel clone. */
export const TELEGRAM_SURFACE: CSSProperties = {
  ["--tg-wallpaper" as string]:
    "linear-gradient(165deg, #e4f0cd 0%, #bfe2a8 40%, #93cf97 100%)",
  ["--tg-bubble-out" as string]: "#e1ffc7",
  ["--tg-accent" as string]: "#2e7cbe",
  ["--tg-check" as string]: "#4fae4e",
  ["--tg-pill" as string]: "rgba(96, 138, 90, 0.55)",
} as CSSProperties;
