# Agent A/B Benchmark — AgentRail vs plain agent (end-to-end tokens)

The context-cost benchmark (`scripts/benchmark-all.py`) measures the tokens to
*gather context*. This protocol measures the **whole agent run**: the same coding
tasks through a real agent (Claude / Codex) **with** vs **without** AgentRail's
MCP context tools, counting total tokens and whether the right context was used.

It is the only experiment that honestly supports a "fewer tokens than
Claude/Codex" claim — so it must be run carefully and reported with its caveats.

> Status: harness + protocol. It needs **your** agent CLI and API key to run;
> `scripts/benchmark-agent-ab.py` produces the results file. Do not publish
> numbers until you have run it.

## Setup

- One model, fixed (e.g. `claude-sonnet`, or a Codex model). Same model in both arms.
- A repo, indexed once: `agentrail context index --target <repo>`.
- Arm **A** is the agent with only its normal file/grep/read tools and no
  AgentRail. No retrieval-first instruction.
- Arm **B** is the same agent told to use the **AgentRail CLI**
  (`agentrail context search` / `context get`) — the token-efficient path
  (`scripts/benchmark-agent-ab.py` adds this instruction by default).
- Optional arm **B-mcp**: the agent uses the AgentRail MCP tools instead. The MCP
  is more convenient/enforceable but costs more tokens per call — measure it as a
  variant, don't assume it matches the CLI.

Everything else is identical: same prompt, same repo, same model, same limits.

## Pilot result (1 task, cursor-agent "auto", single run — directional only)

Express, "explain how `res.json` works":

| arm | tokens | vs plain |
| --- | --- | --- |
| A — plain agent (grep + read) | 34,705 | — |
| **B — AgentRail CLI** | **23,934** | **−31%** |
| B-mcp — AgentRail MCP | 45,998 | +33% |

Takeaways: the **CLI** lowered tokens; the **MCP** raised them (protocol overhead).
Both AgentRail arms over-called (~80–97 lookups for a one-file answer) on this
cheap model — hence the "one focused search, then get the lines" instruction.
This is a single run on a tiny repo; run ≥3× on a large repo before publishing.

## Tasks

`docs/benchmarks/agent-ab-tasks.json` — each task has:
- `prompt`: a realistic instruction ("explain how X works", "fix Y", "where is Z handled").
- `repo`: the indexed repo path.
- `requiredContext`: the file(s) a correct answer must rely on (ground truth).

Tasks should need real context (multi-file, non-obvious), not one-line lookups.

## Metrics (per task, per arm)

| metric | how |
| --- | --- |
| `totalTokens` | input+output tokens reported by the agent CLI (the adapter extracts it) |
| `filesReadInFull` | count of whole-file reads the agent performed |
| `contextFound` | did the run actually use the `requiredContext` file(s)? |
| `success` | did it complete the task? (rubric or manual) |
| `wallMs` | latency |

Aggregate: mean `totalTokens` A vs B and the % difference; `contextFound` and
`success` rates; tokens-per-success.

## Running

```bash
# Example with cursor-agent (claude/codex: swap the command + tokens-path).
PYTHONPATH=. python3 scripts/benchmark-agent-ab.py \
  --tasks docs/benchmarks/agent-ab-tasks.json \
  --agent-cmd 'cursor-agent -p {prompt} --output-format json --trust -f --model auto' \
  --agentrail-bin /abs/path/to/scripts/agentrail \
  --tokens-path 'usage.inputTokens+usage.outputTokens' \
  --repetitions 3 \
  --out docs/benchmarks/results/agent-ab-latest.md
```

- `--agent-cmd`: headless run template; `{prompt}` / `{repo}` are substituted. Same
  command for both arms — only the prompt differs (arm B gets the CLI instruction).
- `--agentrail-bin`: the `agentrail` CLI path the arm-B instruction tells the agent to call.
- `--tokens-path`: where to read token usage in the agent's JSON (claude:
  `usage.input_tokens+usage.output_tokens`; cursor-agent: `usage.inputTokens+usage.outputTokens`).
- `--repetitions`: agents are non-deterministic — run each task N times and average.

## Fairness rules (so the result holds up)

- **Same model, same tasks, same repo.** The only variable is AgentRail availability.
- **Run ≥3 repetitions** and report mean ± spread; one run proves nothing.
- **Pre-register the tasks** (commit `agent-ab-tasks.json` before running) so they
  can't be cherry-picked after seeing results.
- **Report failures and ties**, not just wins. If A and B tie on tokens for trivial
  tasks, say so.
- The expected, honest finding: AgentRail lowers tokens mainly by avoiding
  full-file reads and dead-end exploration — largest on tasks that need scattered
  context, smallest on tasks where one obvious file answers everything.

## Honest caveats

- Token capture depends on the agent CLI exposing usage; verify the adapter on a
  single run before trusting aggregates.
- Agent behaviour drifts with model version and temperature; pin both and date the run.
- This measures *these tasks on these repos*. It is evidence, not a universal law.
