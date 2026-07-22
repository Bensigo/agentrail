/**
 * Marketing route-group layout. Owns the landing page's type-scale
 * primitives (`text-heading-1`, `text-heading-2`, `text-label`,
 * `text-body-sm`, `text-mono-data`) as a scoped <style> tag instead of
 * editing the shared apps/console/app/globals.css — this route is the sole
 * consumer of these exact values today.
 *
 * ONE FACE (owner ruling 2026-07-22): the platform speaks Berkeley Mono —
 * globals.css sets it on <body>, and `.marketing-root` re-states the same
 * stack here (plus the landing's 16px base) so the landing never drifts if
 * the console face evolves. The Source Serif display voice is RETIRED along
 * with Inter; no next/font loads remain in (marketing)/ — the mono stack
 * resolves locally/system-side, so the landing ships zero font bytes.
 * `_craft-pins.test.ts` pins all of this.
 */
const TYPE_SCALE_CSS = `
  .marketing-root {
    font-family: "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco,
      Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 1rem;
  }

  .text-heading-1,
  .text-heading-2 {
    font-weight: 700;
  }

  .text-heading-1 {
    font-size: 2.25rem;
    line-height: 2.5rem;
    letter-spacing: -0.02em;
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
    letter-spacing: -0.02em;
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
    <div className="marketing-root" style={{ display: "contents" }}>
      <style>{TYPE_SCALE_CSS}</style>
      {children}
    </div>
  );
}
