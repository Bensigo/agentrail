# Milestone 022: CLI Cost Wedge + Real-Dollar Cost Engine

## Source

Product repositioning: AgentRail's moat is reducing what teams spend on coding
agents (Claude Code / Codex / Cursor) by 50–70% through context — **without
replacing the high-value agent**. Target market: engineers and startups. The
product is paid, so the one metric that matters everywhere is **savings net of
subscription price**. For this market the **CLI is the product**; the dashboard
is the cost + billing surface (Milestone 023).

## Required Context

- `agentrail/context/benchmark.py`: today the token estimator is `chars/4`
  (`estimate_tokens`); `--compare-grep` already produces a grep-and-read vs
  context-engine cost table. A real-dollar number must replace `chars/4` for any
  in-product savings claim.
- `agentrail/context/retrieval.py`: `runMetadata` accounting (the existing
  `tokensSaved` source, referenced in Milestone 021) — the per-call savings data
  already flows here; it just needs model-aware pricing.
- `agentrail/cli/commands/context.py`: existing `context` subcommands
  (`search`, `get`, `def`, `callers`, `impact`, `ast`, `savings`, `benchmark`).
  New commands are additive; existing contracts are unchanged.
- `packages/mcp/src/index.ts`: the MCP server exposing `context_search`,
  `context_get`, `context_def`, etc. — wired per agent by `init`.
- `templates/scripts/context-first.sh` + `.agentrail/hooks/context-first.sh`:
  the context-first hook is **claude-only** today; Codex and Cursor have no
  hook wiring — that is the adoption tax `init` removes.

## Outcome

A focused, paid, self-serve cost-saver. `agentrail init <claude|cursor|codex>`
wires the MCP server and (where supported) the context-first hook into that
agent's config in one command. Every `context search/get/def` prints an opt-in
per-call savings footer priced in real $ for the active model. `agentrail
savings` reports this-week / this-repo **$ saved vs $ you pay us**. All token
costs are priced from a real per-provider price table, never `chars/4`.

## Wedge vs platform split

The SDLC-orchestration commands (`prd`, `milestone`, `issue`, `grill`, `afk`,
`run`, `timeline`, `review`) are a **separate track**, not part of the
cost-saver onboarding path. This milestone scopes only the `context` cost-saver
and its auth/pricing surface.

## Acceptance Criteria

- [ ] **Real-dollar cost engine**: a provider price table (`Anthropic`,
      `OpenAI`/Codex, `Cursor`) keyed by model, with input / output / cached-read
      / cached-write $ per Mtok. A `--model <id>` flag selects the model; output
      tokens and cached tokens are priced separately. `chars/4` remains only as a
      fallback when a model/tokenizer is unavailable, and is labelled as an
      estimate.
- [ ] `agentrail init <claude|cursor|codex> [--target DIR]` writes the correct
      MCP-server + hook config for that agent (claude: MCP + context-first hook;
      codex/cursor: MCP + prompt steering, since they have no hook mechanism);
      idempotent; prints what it wired and the next step.
- [ ] Per-call savings footer (opt-in, e.g. `--savings` or config flag): each
      `context search/get/def` prints `saved ~N tokens (~$X.XX on <model>) vs
      full-file read`, priced via the cost engine.
- [ ] `agentrail savings [--target DIR] [--json]` reports per-developer /
      per-repo cumulative **$ saved** and **$ saved vs $ subscription** (net),
      this-week and this-repo breakdowns; reads existing `runMetadata`.
- [ ] `agentrail login` / `agentrail plan` (or `usage`): auth + plan + usage this
      cycle + savings-vs-spend. Stub the billing backend behind a clear interface
      if the plan API is not yet live.
- [ ] All existing `context` CLI contracts unchanged (additive only).
- [ ] Existing retrieval quality-gate fixture suite stays green.

## Test Plan

- New: `tests/context/test_pricing.py` — price table lookup per provider/model;
  output vs input vs cached priced distinctly; unknown model falls back to
  `chars/4` with an `estimate: true` flag.
- New: `tests/cli/test_init.py` — `init claude` writes hook + MCP config;
  `init codex` / `init cursor` write MCP + steering, no hook; idempotency.
- Extend `tests/context/test_savings.py` — `savings` returns non-negative `$`
  and a net-of-subscription figure; `--json` schema asserted.
- Manual: run `agentrail context search` with the footer enabled; verify the $
  figure matches the price table for the selected model.

## Likely Issue Slices

- Provider price table + model-aware cost engine (input/output/cached split)
- `agentrail init` wiring for claude / codex / cursor
- Per-call savings footer (opt-in)
- `agentrail savings` reworked for the individual (net-of-subscription)
- `agentrail login` / `plan` / `usage` (billing interface, stubbed backend OK)

## Notes

- The cost engine is the foundation Milestone 023 (dashboard) and Milestone 024
  (tier routing) both depend on — ship it first.
- Honest-number guardrail: the in-product savings figure must come from **real
  per-run data**, not the fixture benchmark. End-to-end evidence today is −24% on
  one task; a 50–70% claim in the UI without real data breaks trust at first
  invoice.
