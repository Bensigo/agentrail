# Agent A/B Benchmark — AgentRail vs plain agent

Tasks: 1 · repetitions: 3 · arm A = plain agent, arm B = agent + AgentRail CLI.
See `docs/benchmarks/agent-ab-protocol.md` for methodology and caveats.

Total tokens — plain agent: **41,055** · AgentRail CLI: **31,092** (−24%).

| task | A mean tokens | B mean tokens | A context-found | B context-found |
| --- | --- | --- | --- | --- |
| requests-prepare-send-redirect | 41055 | 31092 | 1.0 | 1.0 |

## Run details

- Repo: `psf/requests` — multi-file task spanning `models.py` (1184 LOC),
  `sessions.py` (920), `adapters.py` (748).
- Agent: `cursor-agent` "auto" model (free plan), headless. Not Claude/Codex
  specifically — the savings mechanism (compact context vs whole-file reads) is
  agent-agnostic, so similar savings are expected on other agents but were not
  measured here.
- Arm B uses the **AgentRail CLI** (`agentrail context search`/`get`), the
  token-efficient path; the MCP path costs more per call (see protocol doc).
- 3 repetitions per arm; both arms found the required files every time.

## Honest scope

A real, end-to-end measurement — but one task, one repo, one model. Directional
evidence that AgentRail's CLI lowers an agent's tokens (~24% here) at equal
context success. Run more tasks / repos / agents before publishing a single
headline number.
