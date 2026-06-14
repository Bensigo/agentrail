# Milestone 024: Provider-Agnostic Tier Routing

## Source

Product repositioning (see Milestone 022). Model right-sizing is a top cost
lever: reasoning work runs on the expensive tier, implementation on the mid
tier, and everything else (retrieval, rerank, classify, summarize, commit
messages) on the cheap tier. Because the moat spans **Claude Code, Codex, and
Cursor**, the policy cannot be literal model names — it must be an abstract
**tier** mapped per provider.

## Tier abstraction

| Tier | Anthropic (Claude Code) | OpenAI (Codex) | Cursor |
|------|------------------------|----------------|--------|
| **Reasoning** | Opus | GPT high-reasoning | Cursor max/best |
| **Implementation** | Sonnet | GPT mid | Cursor default |
| **Cheap** (retrieval, rerank, classify, summarize, commit msgs) | Haiku | GPT-mini | Cursor cheap |

## Required Context

- `agentrail/context/retrieval.py` and any AgentRail-internal LLM calls
  (enrichment, reranking, memory summarization): these are calls **AgentRail
  fully controls** — they should be forced to the cheap tier regardless of
  provider, immediately. This is free margin.
- Real-dollar cost engine (Milestone 022): tier choices are priced and the
  tier-mix is reported in $ per provider.
- Honest constraint: with Codex and Cursor, AgentRail does **not** control which
  model the host agent picks. For the host, routing is (a) a recommended tier
  policy and (b) a measured mix — full host control requires the request-path
  gateway (the MCP-proxy direction from
  `docs/benchmarks/context-retrieval-cli-benchmark.md` Part 2), out of scope
  here.

## Outcome

A provider-agnostic tier abstraction. AgentRail forces the **cheap tier** on its
own internal LLM calls across all providers. For the host agent, AgentRail
emits a recommended tier per task class and **measures the actual tier mix**,
feeding the dashboard's model-tier-mix panel (Milestone 023).

## Acceptance Criteria

- [ ] A tier enum (`reasoning` / `implementation` / `cheap`) with a per-provider
      model map for Anthropic, OpenAI/Codex, and Cursor; configurable/overridable.
- [ ] AgentRail-internal LLM calls (rerank, enrichment, memory summarization) run
      on the **cheap tier** for the active provider; asserted in tests.
- [ ] A task-class → tier policy (reasoning vs implementation vs cheap) exposed
      to the host agent as a recommendation (instruction / MCP hint), priced via
      the cost engine.
- [ ] Tier mix is recorded per run (which tier each call used) and aggregated per
      provider for the dashboard panel.
- [ ] No host-model takeover is attempted for Codex/Cursor — recommendation +
      measurement only; gateway control is explicitly deferred.

## Test Plan

- New: `tests/context/test_tier_routing.py` — tier→model map resolves per
  provider; internal calls pick the cheap tier; unknown provider falls back
  safely.
- Aggregation: tier-mix roll-up per provider from seeded run telemetry.

## Likely Issue Slices

- Tier enum + per-provider model map
- Force cheap tier on AgentRail-internal LLM calls
- Task-class → tier recommendation for the host agent
- Per-run tier-mix recording + per-provider aggregation

## Blocked By

Milestone 022 (real-dollar cost engine — tier choices must be priced).

## Notes

- The cheap-tier-on-internal-calls slice is the immediate free win — it needs no
  host cooperation and lands savings on day one.
- Full host-model control (forcing the host onto a tier) is the gateway's job and
  is tracked separately, not here.
