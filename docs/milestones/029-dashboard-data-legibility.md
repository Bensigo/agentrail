# Milestone 029: Dashboard Data Legibility & Coverage

## Source PRD

The dashboard *has* data but users can't make meaning of it. Three problems: (1) the **values shown are not human-readable** — surfaces display raw identifiers (`run:a1b2c3d4`, `repository_id`, gate IDs, timeline event IDs) and raw ISO timestamps where a name, title, branch, or relative time would be meaningful; (2) rows don't say which **repo/branch/run** they belong to; (3) core concepts (**review gate**, **behavior linter**) are shown without explanation, and the **M026 optimizations** (prompt caching, output-token reduction, model routing, diffs-over-rewrites) have **no surface at all**. This milestone makes the dashboard data **human-readable first** and complete — explainers are secondary to fixing the actual values on screen.

**Guiding principle 1 — human-readable values (applies to every slice):** show the human-readable value first — repo **name**, task/PR **title**, **branch**, model **name**, a **relative/clear time** ("3 min ago"), status in **words**. Show a raw ID only when there is no human alternative, and then make it secondary (small, monospace, copyable) — never the primary label when a name exists.

**Guiding principle 2 — the right words matter (applies to every slice):** every label, heading, column name, button, empty state, and explainer must use the **precise, correct domain word**, used **consistently** across the whole dashboard. No vague labels ("Conditions" when it means "Criteria checked"), no internal jargon shown raw, no synonyms for the same concept on different pages. Maintain one canonical term per concept (run, context pack, review gate, acceptance criteria, citation, failure, behavior finding, cost, savings) and use it everywhere. Copy is part of the data — a wrong or fuzzy word makes the data unreadable just like a raw ID does. It is about data semantics and coverage — complementary to M028 (visual structure) and bound by the same `docs/design/redesign-direction.md` (dense, scannable, real data, no slop) and TASTE (explain jargon, explicit states).

## Required Context

- `CONTEXT.md`: dashboard pages under `apps/console/app/(dashboard)/dashboard/[workspaceId]/`. Key surfaces: `runs/` (+ `runs/[runId]` with `context-section.tsx`, `cost-section.tsx`, `behavior-lint-section.tsx`), `review-gates/` (+ `[gateId]` with a "Gate Explainer"), `costs/` (with M025 `savings-panel.tsx`, `agent-breakdown.tsx`), `scorecard/`, `context-quality/` (`quality-charts.tsx`), `context-packs/`, `failures/`. M026 data sources: cache-hit/cached-$ (#704), model-routing/recommend (`agentrail/run/cost_recommend.py`, #707/#708), output-waste (#710), diffs-over-rewrites (#709) — these emit telemetry/`cost_optimizer` events but have no console surface.
- `docs/design/redesign-direction.md`: dense observability, real data, no decoration, scanability over hero.
- `TASTE.md`: explain domain concepts where shown; name object/action/result; explicit empty/loading/error; monospace for IDs/paths/timestamps; numbers carry units + scope.

## Outcome

Every dashboard surface states its repo/branch/run scope and explains its concept inline; the M026 optimizations are visible (cache hit-rate + cached-$, output-token waste/savings, model-routing/overspend, diffs savings); review gates and behavior findings are self-explanatory; jargon is defined.

## Users

- Operator who must understand, from the dashboard alone, what a run did, on which repo/branch, what it cost, what the engine saved, whether gates passed and why.

## Vertical Scope (each slice shippable + browser-verified)

- **Human-readable values (cross-cutting, do first)**: across every surface, replace raw identifiers with their human-readable form — resolve `repository_id` → repo name, run ID → task/PR title (ID kept secondary), model IDs → model names, event IDs → a readable label, ISO timestamps → relative/clear time. Where only an ID exists, render it small/monospace/copyable, not as the primary label.
- **Repo/branch/run scoping everywhere**: show repo + branch + (short) run ID on every relevant row; add a branch filter to Review Gates and a visible repo filter to Costs/Scorecard; detail pages show repo+branch+commit prominently.
- **Review-gate legibility**: an inline explanation of what a gate is (acceptance criteria evaluated against run evidence), label each category (ac / tests / citations / visual / blocked) with a one-line meaning, and tie the gate to its run/repo/branch.
- **Behavior-linter legibility**: a description + "why it matters" for each rule (excessive_file_reads, full_file_read, tool_loop, context_blind_edit, verification_skip) and what severity implies; make the evidence link obvious.
- **Context-engine usage clarity**: make citations show real line ranges, indicate the context-first hook was enforced for the run, and separate cache-read savings from retrieval savings (today they're combined).
- **M026 caching surface**: cache **hit-rate %** and **cached-$ saved** (distinct from context-pack savings) per run and per workspace, from #704 telemetry.
- **M026 output-token surface**: output:input ratio with wasteful-run flag, and diffs-over-rewrites output-tokens/$ saved (#709/#710).
- **M026 model-routing surface**: per-run routing recommendations / cheaper-model overspend flags from `cost_recommend.py` (#707/#708).
- **Jargon glossary / inline definitions**: define "stale sources", "denied sources", "precision at budget", "citation coverage", "context pack", "review gate" where they appear (tooltip/inline).

## Acceptance Criteria

- [ ] AC0a (human-readable first, applies everywhere): No surface uses a raw identifier or raw ISO timestamp as a primary value where a human form exists — repo names, task/PR titles, model names, and relative/clear times are shown; any remaining ID is secondary (small, monospace, copyable). Checked on every changed surface.
- [ ] AC0b (right words, applies everywhere): Every label/heading/column/button/empty-state/explainer uses the precise canonical domain term, consistently across pages — no vague labels, no raw jargon, no synonyms for the same concept. Checked on every changed surface.
- [ ] AC1: Every list row and detail header for runs, review-gates, context-packs, failures, costs states its repo + branch (or an explicit "all repos" scope); Review Gates gains a branch filter and Costs/Scorecard a visible repo filter.
- [ ] AC2: The review-gates surface explains what a gate is and labels each category (ac/tests/citations/visual/blocked) with a one-line meaning; a gate clearly shows the run/repo/branch it evaluated.
- [ ] AC3: Each behavior-lint rule shows a plain description + why-it-matters + what its severity implies; evidence links are obviously clickable to the timeline event.
- [ ] AC4: Run context view shows real citation line ranges, indicates context-first hook enforcement, and separates cache-read savings from context-retrieval savings.
- [ ] AC5: The dashboard surfaces M026 cache hit-rate + cached-$ saved, output-token waste + diffs savings, and model-routing/overspend — each labeled with units and scope, sourced from the M026 telemetry/`cost_optimizer` events.
- [ ] AC6: Undefined jargon (stale/denied sources, precision at budget, citation coverage, context pack, review gate) has an inline definition or tooltip where shown.
- [ ] AC7: Design tokens/fonts/colors unchanged; explicit empty/loading/error states; each PR has before/after screenshots of the changed surfaces.

## Likely Issue Slices

- Human-readable values across the dashboard (resolve IDs → names/titles, ISO → relative time; IDs demoted to secondary).
- Repo/branch/run scoping + filters across pages.
- Review-gate legibility (explain + category labels + scope).
- Behavior-linter legibility (rule descriptions + severity meaning).
- Context-engine usage clarity (citations/line-ranges, hook-enforced indicator, cache vs retrieval split).
- M026 caching surface (hit-rate + cached-$).
- M026 output-token surface (waste + diffs savings).
- M026 model-routing surface (recommendations/overspend).
- Jargon glossary / inline definitions.

## Blocked By

Builds on M028's shared primitives (#728 DataTable/StatHeader/states) where available, but each slice can land independently. Reads existing M024/M025/M026 telemetry — no new pipeline work required.
