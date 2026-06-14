# Milestone 022: CLI Cost Wedge + Real-Dollar Cost Engine

## Source

Product repositioning: AgentRail's moat is reducing what teams spend on coding
agents (Claude Code / Codex / Cursor) by 50–70% through context — **without
replacing the high-value agent and without lowering quality**. The belief: high
quality does not require emptying your bank. The **workflow itself is a cost
lever** — a good workflow (loop, review, gates, memory) produces correct work
the first time, so the team pays for fewer failed and retried runs. We do not
remove commands or the existing workflow.

**Surfaces:** the tool is built **for agents**, not humans. The agent surface is
the CLI, MCP tools, hooks, and the workflow (loop / run / review). The **human
surface is the dashboard only** (Milestone 023) — that is where savings, cost,
and billing are read. Auth is via **API key** (no interactive login).

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

`agentrail init <claude|cursor|codex>` wires the MCP server and (where
supported) the context-first hook into that agent's config in one command, using
the configured **API key**. Every context call records a real-$ savings figure
(priced for the active model) into the run's telemetry, which the **human reads
on the dashboard** — not as a human-facing terminal footer. `agentrail savings`
exposes the same data as JSON for tooling. All token costs are priced from a
real per-provider price table, never `chars/4`.

## Workflow is kept (it is the quality-at-low-cost lever)

No commands are removed. The full workflow (`run`, `loop`, `review`, gates,
`memory`, `prd`, `milestone`, `issue`, `afk`, `timeline`) stays — it is how the
agent produces high-quality work the team does not have to pay to redo. The
cost-saver and the workflow are **one product for the agent**, not two tracks.

## Acceptance Criteria

- [ ] **Real-dollar cost engine**: a provider price table (`Anthropic`,
      `OpenAI`/Codex, `Cursor`) keyed by model, with input / output / cached-read
      / cached-write $ per Mtok. A `--model <id>` flag selects the model; output
      tokens and cached tokens are priced separately. `chars/4` remains only as a
      fallback when a model/tokenizer is unavailable, and is labelled as an
      estimate.
- [ ] `agentrail init <claude|cursor|codex> [--target DIR]` writes the correct
      MCP-server + hook config for that agent (claude: MCP + context-first hook;
      codex/cursor: MCP + prompt steering, since they have no hook mechanism),
      using the configured **API key**; idempotent; prints what it wired.
- [ ] **API-key auth**: the key is read from env / config (no interactive login
      flow). `init` and the MCP server use it to attribute runs and usage.
- [ ] Per-call savings is **recorded into run telemetry** (priced via the cost
      engine) so it aggregates to the dashboard. A `--savings` flag may echo it to
      the agent's run log, but the human-facing view is the dashboard, not a
      terminal footer.
- [ ] `agentrail savings [--target DIR] [--json]` exposes cumulative **$ saved**
      and **$ saved vs $ subscription** (net) as JSON for tooling; reads existing
      `runMetadata`. Human reading happens on the dashboard.
- [ ] `agentrail plan` / `usage` (optional): plan + usage this cycle behind a
      billing interface; stub the backend if the plan API is not yet live.
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
- `agentrail init` wiring for claude / codex / cursor (API-key auth)
- Per-call savings recorded into run telemetry (feeds the dashboard)
- `agentrail savings` JSON output (net-of-subscription)
- `agentrail plan` / `usage` (billing interface, stubbed backend OK)

## Notes

- The cost engine is the foundation Milestone 023 (dashboard) and Milestone 024
  (tier routing) both depend on — ship it first.
- Honest-number guardrail: the in-product savings figure must come from **real
  per-run data**, not the fixture benchmark. End-to-end evidence today is −24% on
  one task; a 50–70% claim in the UI without real data breaks trust at first
  invoice.
