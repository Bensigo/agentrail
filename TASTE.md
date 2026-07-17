# TASTE.md

Project taste is the product quality bar agents should apply after reading `CONTEXT.md`.

Keep this file specific to the product. Remove anything that does not help an agent make better trade-offs.

## Product Quality

- Optimize for the user's real workflow, not for showing that a feature exists.
- Prefer fewer, clearer states over broad configuration surfaces.
- Make empty, loading, error, and success states explicit when they affect the workflow.
- Avoid generic placeholder copy. Use the project's domain language.

## Interaction Standards

- Common actions should be obvious without instructional text.
- Destructive or hard-to-reverse actions need confirmation or a clear undo path.
- Controls should use familiar patterns: buttons for commands, toggles for binary settings, tabs for views, menus for option sets, and inputs for user-provided values.
- Do not hide core workflow steps behind decorative layouts.

## UI Standards

- Match the density and tone of the product category.
- Keep visual hierarchy proportional to the surface. Dashboards and internal tools should favor scanability over oversized hero treatment.
- Text must fit its container on mobile and desktop.
- UI-visible PRs need screenshots or video evidence of the actual changed surface.

## Copy Tone

- Be direct and concrete.
- Name the object, action, and result when the user needs to decide.
- Do not use hype language, vague reassurance, or filler.

## Anti-Patterns

- Shipping UI with only the happy path represented.
- Adding decorative elements that make the workflow harder to scan.
- Creating broad settings before the product has proven repeated use.
- Treating test output as visual evidence for UI changes.

---

## Console Design Guide (light-first)

The console is the evidence room behind Jace — a tool for someone who employs an engineer, not an observability platform. It is **light-first**: light background is the default, dark is an opt-in toggle. Surfaces in the "Your engineer" zone (Home, Work, Approvals, Chat) are calm and breathe; engine-room tables (Runs, Review gates, Costs, Failures, Memory) keep density where the data demands it. Density is a tool, not the identity. This guide defines the exact visual system. Do not deviate without explicit approval.

### Typography

**Sans-serif (UI chrome, headings, labels, body):**

```
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
```

**Monospace (data values, event IDs, file paths, code, timestamps, JSON):**

```
font-family: "Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
```

**Type Scale (responsive — mobile / tablet / desktop):**

| Token | Mobile | Tablet | Desktop | Line-height | Letter-spacing |
|-------|--------|--------|---------|-------------|----------------|
| heading-1 | 2.25rem/2.5rem | 3rem/1 | 3.75rem–4.5rem/1 | tight | -0.05em |
| heading-2 | 1.5rem/2rem | 1.875rem/2.25rem | 2.25rem/2.5rem | tight | -0.025em |
| body | 0.875rem (14px) | 0.875rem | 0.875rem | 1.5 (22px) | normal |
| body-sm | 0.75rem (12px) | 0.75rem | 0.75rem | 1.5 (18px) | normal |
| label | 0.75rem (12px) | 0.75rem | 0.75rem | 14px | normal |
| mono-data | 0.8125rem (13px) | 0.8125rem | 0.8125rem | 1.4 | normal |

**Font weights:** Regular (400) for body/data, Bold (700) for headings and emphasis. No thin or black weights.

### Color System

All colors use CSS custom properties with **light-first values — light mode is the default; dark is the opt-in toggle**.

**Gray Scale (neutral backgrounds, borders, text):**

| Token | Light Mode (default) | Dark Mode (toggle) | Usage |
|-------|-----------|------------|-------|
| --gray-00 | #ffffff | #000000 | Page background |
| --gray-01 | #fcfcfc | #111111 | Sidebar/panel background |
| --gray-02 | #f9f9f9 | #191919 | Card/surface background |
| --gray-03 | #f0f0f0 | #222222 | Elevated surface |
| --gray-04 | #e8e8e8 | #2a2a2a | Subtle border, divider |
| --gray-05 | #e0e0e0 | #313131 | Border default |
| --gray-06 | #d9d9d9 | #3a3a3a | Border strong |
| --gray-07 | #cecece | #484848 | Disabled text |
| --gray-08 | #bbbbbb | #606060 | Placeholder text |
| --gray-09 | #8d8d8d | #6e6e6e | Muted text |
| --gray-10 | #838383 | #7b7b7b | Secondary text |
| --gray-11 | #646464 | #b4b4b4 | Body text |
| --gray-12 | #202020 | #eeeeee | Primary text, headings |
| --gray-13 | #0c0c0c | #ffffff | High-contrast text |

**Semantic Colors (status, actions, feedback):**

| Scale | --09 (base) | --11 (text) | Usage |
|-------|------------|-------------|-------|
| Blue | #0090ff | #0d74ce (light) / #70b8ff (dark) | Links, active states, info |
| Green | #29a383 | #208368 (light) / #1fd8a4 (dark) | Success, healthy, passed |
| Red | #e5484d | #ce2c31 (light) / #ff9592 (dark) | Error, failed, critical |
| Orange | #f76b15 | #cc4e00 (light) / #ffa057 (dark) | Warning, degraded, running |
| Yellow | #ffe629 | #9e6c00 (light) / #f5e147 (dark) | Caution, stale |
| Purple | #6e56cf | #6550b9 (light) / #baa7ff (dark) | Context, enrichment |
| Teal | #12a594 | #008573 (light) / #0bd8b6 (dark) | Telemetry, events |

**Brand accent:** amber `#9e6c00` on light backgrounds (the default) for accents and active indicators; lemon `#ffe629` is **fill-with-dark-text only** (primary CTA buttons, highlights) — never text on white. On dark surfaces (opt-in mode) full `#ffe629` works as an accent.

### Spacing

Use a 4px base unit. Standard spacing tokens:

| Token | Value | Usage |
|-------|-------|-------|
| space-1 | 4px (0.25rem) | Tight inline gaps, icon padding |
| space-2 | 8px (0.5rem) | Between related items, badge padding |
| space-3 | 12px (0.75rem) | Input padding, small card padding |
| space-4 | 16px (1rem) | Default gap, card padding |
| space-6 | 24px (1.5rem) | Section gaps, larger card padding |
| space-8 | 32px (2rem) | Between sections |
| space-10 | 40px (2.5rem) | Large section spacing |
| space-12 | 48px (3rem) | Page-level spacing |
| space-16 | 64px (4rem) | Major section breaks |

**Density principle:** density follows the zone. Engine-room tables, sidebars, and filter bars stay tight (`space-2` to `space-4` gaps). "Your engineer" surfaces (Home, Work, Approvals, Chat) breathe — `space-4` to `space-6` between elements. Card padding `space-4` to `space-6`. Reserve `space-8`+ for page-level separation.

### Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| rounded-sm | 2px | Subtle rounding on inline elements, badges |
| rounded | 4px | Buttons, inputs, cards, dropdowns |
| rounded-[2.5px] | 2.5px | Table cells, small UI elements |
| rounded-full | 9999px | Avatars, status dots, pills |

**No large radius on data.** Data-dense components use tight corners — never `rounded-lg` (8px) or `rounded-xl` (12px) on tables, badges, or inputs. Larger radii are acceptable only on marketing surfaces.

### Borders

- Default border: `1px solid var(--gray-06)` (light, default) / `var(--gray-05)` (dark toggle).
- Subtle border: `0.5px solid var(--gray-04)`.
- Strong/hover border: `var(--gray-08)`.
- Dashed borders for drop targets and optional boundaries.
- Border style `border-[0.5px]` is used for ultra-thin separators.

### Shadows

| Token | Value | Usage |
|-------|-------|-------|
| shadow-sm | 0 1px 2px 0 rgb(0 0 0 / 0.05) | Subtle lift on cards |
| shadow | 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1) | Default card shadow |
| shadow-lg | 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1) | Dropdowns, modals |
| shadow-2xl | 0 25px 50px -12px rgb(0 0 0 / 0.25) | Overlays |
| shadow-inner | inset 0 2px 4px 0 rgb(0 0 0 / 0.05) | Inset inputs |

**Dark mode shadows:** Use `rgb(0 0 0 / 0.3–0.5)` for visibility against dark backgrounds.

### Layout

**Sidebar:** Fixed width 220px. Collapsed: 48px (icons only) on mobile. Background: `--gray-01`.

**Content area:** Fluid, max-width 1440px. Background: `--gray-00`.

**Container breakpoints:**

| Breakpoint | Max-width |
|-----------|-----------|
| sm | 640px |
| md | 768px |
| lg | 1024px |
| xl | 1280px |
| 2xl | 1440px |

**Grid:** Use CSS Grid or Flexbox. Common patterns: 1-column mobile, 2-column tablet, 3–4 column desktop for card grids.

### Component Patterns

**Data Tables:**
- Dense: row height 32–36px, `text-sm` (14px) for cell text, `font-mono` for IDs/paths/timestamps.
- Header: `text-xs` (12px), uppercase, `text-gray-09`, `font-medium`.
- Row hover: `bg-gray-02`.
- Row border: `border-b border-gray-04`.
- Sortable columns: arrow indicators in header.

**Filter Bar:**
- Horizontal bar above data tables.
- Compact inputs: height 32px, `rounded` (4px), `border-gray-05`.
- Quick-range buttons for time: 1h, 6h, 24h, 7d, 30d, custom.
- Active filters shown as removable pills/badges.

**Status Badges:**
- Compact: `px-1.5 py-0.5 rounded-sm text-xs font-medium`.
- Colors: green=success/healthy, red=failed/error, orange=running/warning, yellow=stale/caution, gray=queued/inactive.

**Timeline:**
- Vertical line on left (2px, `bg-gray-05`).
- Event dots: 8px circles, color-coded by event type.
- Timestamp in `font-mono text-xs text-gray-09`.
- Expandable detail below each event entry.

**Cards/Panels:**
- Background: `--gray-02`.
- Border: `1px solid var(--gray-05)`.
- Padding: `space-4` (16px).
- Border radius: `rounded` (4px).

**Buttons:**
- Primary: `bg-[#ffe629] text-black`, `rounded` (4px), `px-4 py-2`. Hover: `bg-[#ffdc00]`.
- Secondary: `bg-gray-03 border-gray-06 text-gray-12`, `rounded` (4px).
- Ghost: transparent background, `text-gray-11`, hover `bg-gray-02`.
- Height: 32px (sm), 36px (default), 40px (lg).

**Inputs:**
- Height: 32px.
- Background: `--gray-02`.
- Border: `1px solid var(--gray-05)`.
- Focus: `ring-2 ring-[#ffe629]` with `ring-offset-2`.
- Placeholder: `text-gray-08`.
- Font: `text-sm` for labels, `font-mono text-sm` for code/path inputs.

### Animation & Transitions

- Default transition: `150ms ease` for colors, backgrounds, borders, opacity.
- Dropdowns/modals: `zoom-in-95` + `fade-in-0` on open, `zoom-out-95` + `fade-out-0` on close.
- Loading states: `animate-pulse` for skeleton placeholders.
- No decorative animations. Motion serves state changes only.

### Severity & Health Mapping

| State | Color Scale | Icon | Text |
|-------|------------|------|------|
| Healthy / Passed / Success | Green | Checkmark | "Healthy" / "Passed" |
| Running / In Progress | Orange | Spinner / Clock | "Running" |
| Warning / Stale (< 24h) | Yellow | Triangle | "Stale" / "Warning" |
| Failed / Error / Critical | Red | X / Alert | "Failed" / "Error" |
| Queued / Inactive / Unknown | Gray | Circle / Dash | "Queued" / "—" |

### Route Architecture

The console app's top-level route groups:

```
apps/console/app/
  (marketing)/         — public landing (no auth required)
    page.tsx           — Jace's resume (the landing page)
  (docs)/              — documentation site (Fumadocs)
  (dashboard)/         — authenticated console (workspace-scoped)
    dashboard/[workspaceId]/
      work/            — the task board (/queue redirects here)
      runs/
      review-gates/
      costs/
      failures/
      memory/
      repos/
      connectors/
      members/  teams/  api-keys/
    setup/             — onboarding wizard (derived-state)
  (auth)/              — login + callback routes
```

Arriving with the end-to-end arc: `approvals/` and `chat/` under the
workspace, per the arc spec. Scorecard and Context Quality were removed
deliberately — observability stays light; do not reintroduce them.

**The landing page is Jace's resume.** Light, single-column, persona-led —
in the spirit of boardy.ai, not cursor.com's dark-premium mood. Structure:
who I am → how I work → track record (real numbers, failures counted) → how
we work together → **Message me** (primary CTA) with a secondary
sign-up/sign-in button. The centerpiece demo is a real chat conversation
with Jace — never a dashboard mockup, and never surfaces the product no
longer has. Same font stack (Inter + Berkeley Mono); amber `#9e6c00` accent
on light, lemon `#ffe629` as fill-with-dark-text only — never decorative
glow blobs, pulsing-dot pill badges, or an uppercase-mono eyebrow on every
section (those read as AI-generated). Voice stays direct, concrete, no hype.
The page claims only what the live flow does.

**Console pages** use the light-first system defined above: calm in the
"Your engineer" zone, dense in the engine room.

### Information Architecture Principles

1. **Overview first, detail on demand.** Every view starts with a filterable list/table. Detail is one click away.
2. **Evidence over claims.** Every status, failure, or decision must link to underlying events or artifacts.
3. **Scannable at the zone's density.** Engine-room views pack information tight; Your-engineer views stay calm. Both keep clear hierarchy with typography weight and color contrast.
4. **Workspace-scoped everything.** Every view operates within one workspace context. The workspace switcher is always accessible.
5. **Time is primary axis.** Most views sort by time. Time range controls appear on every event-driven view.
6. **No vanity metrics.** Every number must be actionable. If you can't drill into it, don't show it.
7. **Monospace for machine data.** IDs, paths, hashes, timestamps, JSON, and code always use Berkeley Mono.
