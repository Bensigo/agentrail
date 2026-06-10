# AgentRail Context Retrieval — Benchmarks

_All numbers are measured and reproducible (`scripts/benchmark-all.py`). They are scoped to the runs described below, not universal guarantees — per the project's benchmark claim rules._

## Headline

- **Same files as grep, a fraction of the tokens.** On express@5.2.1 symbol lookups, AgentRail returned the required file every time (100% recall) using **3,034 tokens** of compact context vs **5,641,768** to read grep's matches in full (-100%) and **189,495** for ripgrep's (-98%).
- **Ranks the right file first.** Definition ranked #1 in **83%** of lookups (grep/ripgrep return an unordered pile).
- **Finds code by meaning, not just keywords.** With embeddings on (qwen3-embedding:latest), the correct file ranked #1 on 2/3 conceptual queries that share no words with it (2 flipped from a wrong #1 under keyword-only search).

## 1. Exact / symbol lookup — AgentRail vs grep vs ripgrep

Target: **express@5.2.1** · 6 symbol queries with ground-truth definition files · embeddings off.

| metric | grep | ripgrep | AgentRail |
| --- | --- | --- | --- |
| recall (finds the file) | 1.00 | 1.00 | 1.00 |
| precision@1 (definition ranked first) | — | — | **0.83** |
| tokens to obtain context | 5,641,768 | 189,495 | **3,034** |

| query | required | grep R/P (n) | rg R/P (n) | AgentRail R/P (n) | AR rank |
| --- | --- | --- | --- | --- | --- |
| `res.json` | lib/response.js | 1.00/0.05 (20) | 1.00/0.06 (16) | 1.00/0.10 (10) | #1 |
| `res.sendFile` | lib/response.js | 1.00/0.11 (9) | 1.00/0.20 (5) | 1.00/0.14 (7) | #1 |
| `req.accepts` | lib/request.js | 1.00/0.09 (11) | 1.00/0.14 (7) | 1.00/0.10 (10) | #1 |
| `app.listen` | lib/application.js | 1.00/0.03 (34) | 1.00/0.03 (30) | 1.00/0.10 (10) | #1 |
| `createApplication` | lib/express.js | 1.00/0.25 (4) | 1.00/1.00 (1) | 1.00/0.25 (4) | #1 |
| `function View` | lib/view.js | 1.00/0.33 (3) | 1.00/0.50 (2) | 1.00/0.10 (10) | #2 |

## 2. Semantic / conceptual retrieval

Plain-English questions whose answer file shares **no keywords** with the question (a decoy file does). Shows whether retrieval finds code by meaning.

Embeddings: **qwen3-embedding:latest** (local Ollama).

| query | correct file | rank: keyword-only | rank: semantic on |
| --- | --- | --- | --- |
| `how do we decide if a user is allowed in` | src/gatekeeper.py | #4 | **#1** |
| `where do we keep results temporarily to avoid recomputing` | src/memo.py | not found | **#1** |
| `what makes a draft visible to the public` | src/release.py | #5 | **#2** |

## Honest caveats
- Recall ties with grep/ripgrep on literal lookups; AgentRail's edge is **fewer tokens** and **ranking the right file first**, plus conceptual queries grep cannot do.
- Set-precision is not AgentRail's lens (it returns a ranked top-K); precision@1 and token cost are.
- The semantic section uses controlled fixtures to isolate meaning-vs-keyword; broaden it on real repos before headline use.

## Reproduce
```bash
PYTHONPATH=. python3 scripts/benchmark-all.py \
  --exact-target /path/to/express --embed-model qwen3-embedding:latest \
  --out docs/benchmarks/results/context-retrieval-cli-latest.md
```
