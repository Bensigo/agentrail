/**
 * Marketing route-group layout. Owns the landing page's TASTE.md type-scale
 * primitives (`text-heading-1`, `text-heading-2`, `text-label`,
 * `text-body-sm`, `text-mono-data`) as a scoped <style> tag instead of
 * editing the shared apps/console/app/globals.css — the #1279 craft redo is
 * scoped to (marketing)/ only (hard constraint: zero changes outside this
 * directory), and this route is the sole consumer of these exact values
 * today. Values are copied verbatim from TASTE.md's Typography table; body
 * (14px/1.5), body-sm/label (12px), and the Berkeley Mono family itself
 * already come from the global `body{}` rule and `.font-mono` class in
 * globals.css and need no local override.
 */
const TYPE_SCALE_CSS = `
  .text-heading-1 {
    font-size: 2.25rem;
    line-height: 2.5rem;
    letter-spacing: -0.05em;
  }
  @media (min-width: 768px) {
    .text-heading-1 { font-size: 3rem; line-height: 1; }
  }
  @media (min-width: 1024px) {
    /* Linear ramp solved to hit exactly 3.75rem at the 1024px breakpoint
       and 4.5rem at 1440px (a common large-desktop reference width), so
       the full 3.75–4.5rem range from TASTE.md's table is actually used
       across real desktop viewports instead of jumping straight to the
       high end. */
    .text-heading-1 { font-size: clamp(3.75rem, 2.88vw + 1.9rem, 4.5rem); line-height: 1; }
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
    <>
      <style>{TYPE_SCALE_CSS}</style>
      {children}
    </>
  );
}
