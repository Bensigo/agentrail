# Milestone 022: CLI Cost Wedge — Real-Dollar Engine + Multi-Agent Init

## Source PRD

Cost-wedge arc (M022-M025): make AgentRail prove **real dollars** saved/spent across coding agents (claude/codex/cursor), and lower the adoption tax so non-claude agents can use the context engine. M022 is the foundation slice — milestones 023/024/025 all price through this engine.

## Required Context

- `CONTEXT.md`: token estimator is `chars/4` (`retrieval.py:163` `estimate_tokens`); `tokensSaved` accounting lives in `retrieval.py:1612` and `packs.py:424`; benchmark cost columns come from `benchmark.py:149` `run_benchmark(..., compare_grep)`; the context-first hook (`templates/scripts/context-first.sh`, `.agentrail/hooks/context-first.sh`) is **claude-only** today — codex/cursor have no wiring mechanism, which is the adoption tax this milestone removes; the MCP server in `packages/mcp/src/index.ts` exposes `context_search`/`context_get`/`context_def`/etc.
- `TASTE.md`: Evidence over claims — cost numbers must be auditable and honest. Output (input/output/cached-read/cached-write) priced separately; unknown models flagged `estimate: true`, never silently mispriced.

## Outcome

A provider price table (Anthropic, OpenAI/Codex, Cursor) keyed by model with input / output / cached-read / cached-write $ per Mtok, and a model-aware costing function that prices input, output, and cached tokens **separately** (output is ~5× input). `chars/4` stays only as a labeled fallback. `agentrail init <claude|cursor|codex>` writes the MCP-server + (claude-only) context-first hook config for that agent using the configured API key — idempotent, no interactive login.

## Users

- Operator who wants AgentRail's savings/cost numbers in real dollars, not abstract tokens
- Coding agent on codex/cursor that today has no way to be wired to the context engine
- Developer extending pricing for a new provider/model

## Vertical Scope

- Domain logic: provider price table module (`agentrail/context/pricing.py` or similar); model-aware `cost_for(model, input_tokens, output_tokens, cached_read, cached_write) -> dollars` pricing input/output/cached distinctly; `chars/4` retained as labeled fallback; `agentrail init <agent> [--target DIR]` command writing MCP + (claude) hook config from API key.
- Data/storage: no schema changes.
- Integrations/jobs: none.
- Tests: `tests/context/test_pricing.py` (per-provider lookup + fallback + output≠input); `tests/cli/test_init.py` (all three providers + idempotency).
- Docs/config: `templates/AGENTS.md` note that codex/cursor get MCP + steering (no hook).

## Acceptance Criteria

- [ ] AC1: Price table covers Anthropic, OpenAI/Codex, Cursor models with in/out/cached-read/cached-write $ per Mtok.
- [ ] AC2: Costing function prices output and cached tokens distinctly from input (output rate > input rate).
- [ ] AC3: Unknown model falls back to `chars/4` flagged `estimate: true`.
- [ ] AC4: `agentrail init claude` writes MCP + context-first hook config; `init codex`/`init cursor` write MCP + steering, no hook.
- [ ] AC5: `init` reads API key from env/config (no interactive login) and is idempotent (re-run adds no duplicate config).
- [ ] AC6: `tests/context/test_pricing.py` and `tests/cli/test_init.py` pass; all prior suites stay green.

## Likely Issue Slices

- [#693] Cost engine: provider price table + model-aware token costing.
- [#694] CLI: `agentrail init <claude|cursor|codex>` wires MCP + hook with API-key auth.

## Blocked By

None — foundation slice.
