# Milestone 027: Landing Page Redesign — Editorial, No AI Slop

## Source PRD

The landing page (`apps/console/app/(marketing)/page.tsx`, ~1017 lines) uses the correct brand design system but a generic AI-generated **structure**: a decorative "Atmosphere" background, a bento capability grid, repeated rounded-card rows, centered-everything sections. Redesign the structure and composition to the editorial, product-forward craft of the reference sites — **keeping the design tokens, fonts, and colors unchanged**.

## Required Context

- `CONTEXT.md`: landing lives at `apps/console/app/(marketing)/page.tsx` with `_dashboard-demo.tsx` (product demo), `_motion.tsx` (animation), `layout.tsx`. Design tokens + type scale in `TASTE.md` § Console Design Guide and `apps/console/app/globals.css` — **do not change them**. Real benchmark data for proof sections comes from `docs/benchmarks/results/`.
- `docs/design/redesign-direction.md`: the anti-AI-slop art-direction bar (reference sites, banned patterns, required craft, verification). **This is the design contract for every slice.**
- `TASTE.md`: editorial restraint, concrete copy (no hype), real product surfaces, mandatory browser-screenshot evidence; reduced-motion safe.

## Outcome

A landing page that reads as crafted and product-forward — editorial asymmetric layout, real product surfaces shown big, restrained palette, concrete domain copy, purposeful motion — with **zero** AI-slop patterns (no atmosphere glow, no bento crutch, no emoji icons, no repeated identical cards, no centered-everything). Same brand tokens throughout.

## Users

- Prospective operator/buyer evaluating AgentRail who should immediately grasp the product from real surfaces, not marketing fluff.

## Vertical Scope (each slice is shippable + browser-verified)

- Remove the AI-slop scaffold + establish the editorial structure: delete the `{/* Atmosphere */}` decorative layer, define the new section grid/rhythm, redesign nav + footer (structured multi-column, real links).
- Hero redesign: left-aligned confident type hierarchy, concrete value copy, real product surface adjacent (asymmetric), restrained accent.
- Product showcase: replace the bento grid with a real, product-accurate interactive/screenshot showcase (evolve `_dashboard-demo.tsx`) demonstrating the actual console.
- Capability/value sections: replace "How it works" step cards + bento + CLI-vs-Console with distinct, editorially-composed sections using domain language.
- Proof section: redesign the benchmark/proof section around the real `docs/benchmarks/results/` numbers (honest, auditable), not generic stat cards.
- FAQ + final CTA redesign: concrete, no hype; CTA earns the click.
- Motion pass: purposeful, reduced-motion-safe animation (rive/miro style) replacing ambient decoration.

## Acceptance Criteria

- [ ] AC1: The decorative "Atmosphere"/glow background and any blurry-orb/gradient-blob decoration are removed; backgrounds use design-system tokens only.
- [ ] AC2: No bento grid and no rows of repeated identical cards remain as primary layout; sections are editorially distinct and at least partly asymmetric/left-aligned.
- [ ] AC3: No emoji used as iconography; no generic stock illustration or fake floating-UI mockups — the product is shown via real/accurate console surfaces.
- [ ] AC4: Copy follows TASTE tone (concrete, domain language, no hype words like "supercharge/unlock/seamless"); proof numbers trace to `docs/benchmarks/results/`.
- [ ] AC5: Design tokens, fonts, and color values are unchanged (diff touches layout/structure/copy, not `globals.css` token values or the type scale).
- [ ] AC6: Fully responsive (mobile/tablet/desktop); `prefers-reduced-motion` disables non-essential motion.
- [ ] AC7: Each PR includes before/after browser screenshots (desktop + mobile) of the changed sections; motion changes include a short video.

## Likely Issue Slices

- Strip AI-slop scaffold + new editorial structure (grid, nav, footer).
- Hero redesign (asymmetric, real product surface).
- Real product showcase (replace bento; evolve `_dashboard-demo.tsx`).
- Capability/value sections (replace how-it-works + bento + CLI-vs-console).
- Proof/benchmark section (real numbers).
- FAQ + final CTA redesign.
- Purposeful motion pass (reduced-motion safe).

## Blocked By

None. (Each slice is independent; the scaffold slice should land first so others build on the new structure.)
