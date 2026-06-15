# AgentRail Context Retrieval — Benchmarks

_All numbers are measured and reproducible (`scripts/benchmark-all.py`). They are scoped to the runs described below, not universal guarantees — per the project's benchmark claim rules._

_Regenerated 2026-06-15 against Context Engine v2 (tree-sitter symbol graph + call edges)._

## Headline

- **Same files, far fewer tokens — even vs a *smart* agent.** Across 2 real repos (express (6), flask (5)), AgentRail found the required file every time (100% recall) using **6,279 tokens** of compact context. Reading those same right files in full (best case for a grep/ripgrep agent) costs **52,249** (-88%); reading *every* grep match in full costs **25,689,038** (-100%).
- **Ranks the right file first.** Definition ranked #1 in **82%** of lookups across both languages (grep/ripgrep return an unordered pile).
- **Finds code by meaning, not just keywords.** With embeddings on (qwen3-embedding:latest), the correct file ranked #1 on 2/3 conceptual queries that share no words with it (2 flipped from a wrong #1 under keyword-only search).
- **Makes your agent cheaper end-to-end.** Running the same task through a real agent with vs without the AgentRail CLI cut total tokens at equal accuracy (see section 3) — AgentRail is a layer on top of any agent, not a competing one.

## 1. Exact / symbol lookup — AgentRail vs grep vs ripgrep

2 real repos (express (6), flask (5)) · symbol queries with ground-truth definition files · embeddings off.

| metric | grep | ripgrep | AgentRail |
| --- | --- | --- | --- |
| recall (finds the file) | 1.00 | 1.00 | 1.00 |
| precision@1 (definition ranked first) | — | — | **0.82** |
| tokens to obtain context | 25,689,038 | 642,492 | **6,279** |

### Context-gathering token cost (the token-savings claim)

How many tokens an agent spends just to *get the context* for these tasks, by strategy:

| strategy | tokens | vs AgentRail |
| --- | --- | --- |
| naive: grep, read every matched file in full | 25,689,038 | AgentRail -100% |
| smart agent: read only the right files, in full | 52,249 | AgentRail -88% |
| **AgentRail: read the returned line ranges** | **6,279** | — |

Both baselines are shown so the range is honest: AgentRail beats even the *generous* baseline (an agent that magically opens exactly the right files) because it reads line ranges, not whole files.

### express

| query | required | grep R/P (n) | rg R/P (n) | AgentRail R/P (n) | AR rank |
| --- | --- | --- | --- | --- | --- |
| `res.json` | lib/response.js | 1.00/0.06 (16) | 1.00/0.06 (16) | 1.00/0.10 (10) | #1 |
| `res.sendFile` | lib/response.js | 1.00/0.10 (10) | 1.00/0.20 (5) | 1.00/0.10 (10) | #1 |
| `req.accepts` | lib/request.js | 1.00/0.08 (12) | 1.00/0.14 (7) | 1.00/0.10 (10) | #1 |
| `app.listen` | lib/application.js | 1.00/0.03 (35) | 1.00/0.03 (30) | 1.00/0.10 (10) | #1 |
| `createApplication` | lib/express.js | 1.00/0.20 (5) | 1.00/1.00 (1) | 1.00/0.20 (5) | #1 |
| `function View` | lib/view.js | 1.00/0.33 (3) | 1.00/0.50 (2) | 1.00/0.10 (10) | #2 |

### flask

| query | required | grep R/P (n) | rg R/P (n) | AgentRail R/P (n) | AR rank |
| --- | --- | --- | --- | --- | --- |
| `jsonify` | src/flask/json/__init__.py | 1.00/0.05 (21) | 1.00/0.05 (21) | 1.00/0.17 (6) | #1 |
| `url_for` | src/flask/app.py | 1.00/0.02 (51) | 1.00/0.02 (47) | 1.00/0.10 (10) | #2 |
| `render_template` | src/flask/templating.py | 1.00/0.03 (36) | 1.00/0.03 (32) | 1.00/0.10 (10) | #1 |
| `send_file` | src/flask/helpers.py | 1.00/0.08 (13) | 1.00/0.11 (9) | 1.00/0.12 (8) | #1 |
| `stream_with_context` | src/flask/helpers.py | 1.00/0.07 (14) | 1.00/0.10 (10) | 1.00/0.12 (8) | #1 |

## 2. Semantic / conceptual retrieval

Plain-English questions whose answer file shares **no keywords** with the question (a decoy file does). Shows whether retrieval finds code by meaning.

Embeddings: **qwen3-embedding:latest** (local Ollama).

| query | correct file | rank: keyword-only | rank: semantic on |
| --- | --- | --- | --- |
| `how do we decide if a user is allowed in` | src/gatekeeper.py | #4 | **#1** |
| `where do we keep results temporarily to avoid recomputing` | src/memo.py | not found | **#1** |
| `what makes a draft visible to the public` | src/release.py | #5 | **#2** |

## 3. End-to-end agent run (real tokens, with vs without AgentRail)

AgentRail is a layer **on top of** your agent — it feeds compact context instead of whole files, so it makes whichever agent you use cheaper. Measured by running the *same* task through an agent with vs without the AgentRail CLI:

Total tokens — plain agent: **41,055** · AgentRail CLI: **31,092** (−24%).

| task | A mean tokens | B mean tokens | A context-found | B context-found |
| --- | --- | --- | --- | --- |
| requests-prepare-send-redirect | 41055 | 31092 | 1.0 | 1.0 |

The savings mechanism is agent-agnostic, so a similar cut is expected on Claude/Codex (not yet measured). Source: `docs/benchmarks/results/agent-ab-latest.md`.

## Honest caveats
- Recall ties with grep/ripgrep on literal lookups; AgentRail's edge is **fewer tokens** and **ranking the right file first**, plus conceptual queries grep cannot do.
- The end-to-end agent number is one task / repo / model (cursor 'auto'); directional, not a universal guarantee — run more before a hard headline.
- Set-precision is not AgentRail's lens (it returns a ranked top-K); precision@1 and token cost are.
- The semantic section uses controlled fixtures to isolate meaning-vs-keyword; broaden it on real repos before headline use.

## Reproduce
```bash
PYTHONPATH=. python3 scripts/benchmark-all.py \
  --repo express=/path/to/express --repo flask=/path/to/flask \
  --embed-model qwen3-embedding:latest \
  --out docs/benchmarks/results/context-retrieval-cli-latest.md
```
