import { Source_Serif_4 } from "next/font/google";

/**
 * Landing display serif (owner-directed, #1279 round 2 — heyparker.ai as
 * the aesthetic guide, executed through our tokens): serif DISPLAY headings
 * on the warm-paper surface, body stays Inter, data stays Berkeley Mono.
 * Loaded here (not the root layout) so the font is landing-scoped, and
 * exposed as a CSS variable consumed only by `.text-heading-1/2` below —
 * which the page applies exactly to the h1 + section h2s. Weights 600/700
 * per the round-2 ruling; 600 is the display weight in use (700 stays
 * loaded for emphasis-in-heading safety). This is the ONLY sanctioned
 * next/font/google load in (marketing)/ — `_craft-pins.test.ts` pins that
 * (the Bricolage Grotesque ban stays).
 */
const displaySerif = Source_Serif_4({
  subsets: ["latin"],
  // 400 joined the set with the owner's 2026-07-22 ruling: the landing
  // renders BODY copy in the serif too (Inter is off this surface
  // entirely); 600 stays the display weight, 700 for bold emphasis.
  weight: ["400", "600", "700"],
  display: "swap",
  variable: "--font-display",
});

/**
 * Marketing route-group layout. Owns the landing page's TASTE.md type-scale
 * primitives (`text-heading-1`, `text-heading-2`, `text-label`,
 * `text-body-sm`, `text-mono-data`) as a scoped <style> tag instead of
 * editing the shared apps/console/app/globals.css — the #1279 craft redo is
 * scoped to (marketing)/ only (hard constraint: zero changes outside this
 * directory), and this route is the sole consumer of these exact values
 * today. Sizes are TASTE.md's Typography table verbatim; body (14px/1.5),
 * body-sm/label (12px), and the Berkeley Mono family itself already come
 * from the global `body{}` rule and `.font-mono` class in globals.css and
 * need no local override.
 *
 * Display headings render in the serif above at weight 600. The h1's
 * letter-spacing is -0.025em, not the table's -0.05em: the -0.05em value
 * was tuned for the sans; on a serif it crushes the letterforms (round-2
 * ruling explicitly allows this relaxation — judged by rendered output).
 * Desktop h1 line-height is 1.05 rather than 1 for the same reason: serif
 * ascenders/descenders need a hair more leading at display sizes to avoid
 * clipping between the hero's two lines.
 */
const TYPE_SCALE_CSS = `
  /* The landing speaks in its own faces only (owner ruling 2026-07-22:
     no Inter on this surface): the serif inherits to every descendant —
     including buttons, via preflight's font:inherit — while .font-mono /
     .text-mono-data set Berkeley Mono directly and therefore win. Base
     size steps up to 16px for the marketing voice; the explicit
     text-label/body-sm/mono-data sizes below still override. */
  .marketing-root {
    font-family: var(--font-display), Georgia, "Times New Roman", serif;
    font-size: 1rem;
  }

  .text-heading-1,
  .text-heading-2 {
    font-family: var(--font-display), Georgia, "Times New Roman", serif;
    font-weight: 600;
  }

  .text-heading-1 {
    font-size: 2.25rem;
    line-height: 2.5rem;
    letter-spacing: -0.025em;
  }
  @media (min-width: 768px) {
    .text-heading-1 { font-size: 3rem; line-height: 1.05; }
  }
  @media (min-width: 1024px) {
    /* Linear ramp solved to hit exactly 3.75rem at the 1024px breakpoint
       and 4.5rem at 1440px (a common large-desktop reference width), so
       the full 3.75–4.5rem range from TASTE.md's table is actually used
       across real desktop viewports instead of jumping straight to the
       high end. */
    .text-heading-1 { font-size: clamp(3.75rem, 2.88vw + 1.9rem, 4.5rem); line-height: 1.05; }
  }

  .text-heading-2 {
    font-size: 1.5rem;
    line-height: 2rem;
    letter-spacing: -0.025em;
  }
  @media (min-width: 768px) {
    .text-heading-2 { font-size: 1.875rem; line-height: 2.25rem; }
  }
  @media (min-width: 1024px) {
    .text-heading-2 { font-size: 2.25rem; line-height: 2.5rem; }
  }

  .text-label {
    font-size: 0.75rem;
    line-height: 14px;
  }

  .text-body-sm {
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .text-mono-data {
    font-size: 0.8125rem;
    line-height: 1.4;
  }
`;

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      className={`${displaySerif.variable} marketing-root`}
      style={{ display: "contents" }}
    >
      <style>{TYPE_SCALE_CSS}</style>
      {children}
    </div>
  );
}
