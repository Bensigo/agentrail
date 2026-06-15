# Redesign Direction — Kill the AI Slop (Landing + Dashboard)

The brand design system (color tokens, Inter / Berkeley Mono, type scale, spacing) in `TASTE.md` § Console Design Guide and `apps/console/app/globals.css` is **correct and stays**. What changes is **structure and composition** — the current pages are filled with generic AI-generated patterns. This doc is the art-direction bar for milestones 027 (landing) and 028 (dashboard). Every redesign issue cites it.

## Reference sites (study these, match their craft — not their content)

| Site | What to take from it |
|---|---|
| notion.com, figma.com | Editorial layout, generous intentional whitespace, **real product surfaces** shown big, confident type hierarchy |
| miro.com, monday.com | Clear product value framing; purposeful motion that demonstrates the product, never decoration |
| slite.com, formcarry.com, boki.io | Clean SaaS structure: asymmetric section rhythm, real interface mockups (not abstract illustration), structured multi-column footer, tangible social proof |
| rive.app | Motion with intent — animation shows the product working, not gratuitous orbs |
| trello.com, pinterest.com | Strong information architecture; distinct, scannable sections |

Common thread: **real product, real data, editorial composition, restraint.**

## Banned — AI-slop patterns to remove on sight

- Decorative gradient/glow "atmosphere" backgrounds, blurry orbs/blobs, aurora gradients (the current landing's `{/* Atmosphere */}` layer).
- Bento grids used as a default layout crutch; rows of identical rounded cards repeated down the page.
- Emoji used as iconography / bullet markers.
- Generic stock illustrations, abstract 3D shapes, fake floating UI cards, glassmorphism.
- Centered-everything monotony — every section a centered heading + subhead + card row.
- Hype/vague copy ("supercharge", "unlock", "seamlessly", "powerful"), fake testimonials, placeholder logos.
- Oversized hero on internal/dashboard surfaces (violates TASTE density rule).

## Required — what crafted looks like here

- **Editorial, asymmetric layout.** Left-aligned strong typographic hierarchy; vary section composition; deliberate whitespace. Not every section centered.
- **Show the real product.** Use the actual console components / real screenshots / a live interactive demo (the existing `_dashboard-demo.tsx` is the seed — make it real and product-accurate), not mockups of a fictional UI.
- **Restraint.** Palette strictly from the design-system tokens; one accent, used sparingly. Type does the work, not color.
- **Concrete copy** per TASTE § Copy Tone: name the object, action, result. Domain language (runs, context packs, review gates, real-dollar cost), no hype.
- **Motion with purpose** (rive/miro style): animate to demonstrate a capability, subtle, reduced-motion-safe. No ambient floating.
- **Distinct sections.** Each major section gets its own composition appropriate to its content, not a repeated template.

## Constraints

- Do NOT change the design tokens, fonts, or color values. Reuse `var(--gray-*)`, the type scale, spacing.
- Keep it responsive (mobile/tablet/desktop per the TASTE type scale); text must fit its container.
- Reduced-motion (`prefers-reduced-motion`) must disable non-essential animation.
- Dashboard surfaces favor **scanability/density** over hero treatment (TASTE UI Standards).

## Verification (mandatory, per TASTE)

- Every PR is UI-visible → **browser screenshots** (and short video for motion) of the actual changed surface, desktop + mobile widths. CI skips console tests, so visual evidence in the PR is the gate.
- A before/after screenshot for redesigned sections.
- Lighthouse/perf not regressed by added motion/assets.
