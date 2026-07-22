import type { CSSProperties } from "react";

/** Telegram-look tokens for the landing's phone demo (owner directive
 *  2026-07-22: the demo should read as the REAL channel Jace lives on, not
 *  a generic chat). Hex values live HERE — a token file outside the pinned
 *  marketing components (same pattern as `light-surface.ts`) — so
 *  `_phone-demo.tsx` / `_conversation-demo.tsx` stay hex-free and consume
 *  `var(--tg-*)` classes only. Values approximate Telegram's Android light
 *  theme: the blue app bar, the cool chat backdrop, the classic green
 *  outgoing bubble, the inline-keyboard/link blue, the read-check green.
 *  Familiar chrome, not a pixel clone. */
export const TELEGRAM_SURFACE: CSSProperties = {
  ["--tg-header" as string]: "#527da3",
  ["--tg-header-text" as string]: "#ffffff",
  ["--tg-bg" as string]: "#e3ebf2",
  ["--tg-bubble-out" as string]: "#effdde",
  ["--tg-accent" as string]: "#2e7cbe",
  ["--tg-check" as string]: "#4fae4e",
} as CSSProperties;
