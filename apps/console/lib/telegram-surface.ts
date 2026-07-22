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
  // The real wallpaper, two layers: the tiled doodle line-art
  // (public/tg-doodles.svg) over the yellow-green -> teal gradient from
  // the owner's reference image. Applied here as actual background
  // properties since this object styles the frame root directly.
  backgroundImage:
    "url('/tg-doodles.svg'), linear-gradient(170deg, #cadb5e 0%, #7dc98e 52%, #48b39e 100%)",
  backgroundSize: "240px auto, cover",
  backgroundRepeat: "repeat, no-repeat",
  ["--tg-bubble-out" as string]: "#e1ffc7",
  ["--tg-accent" as string]: "#2e7cbe",
  ["--tg-check" as string]: "#4fae4e",
  ["--tg-pill" as string]: "rgba(69, 129, 103, 0.55)",
} as CSSProperties;
