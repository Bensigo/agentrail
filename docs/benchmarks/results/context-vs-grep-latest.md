# Context Retrieval — AgentRail vs grep vs ripgrep

Target: **express@5.2.1** (real codebase) · fixtures: 6 · K(agentrail)=10 · embeddings: disabled

_Measured by `scripts/benchmark-vs-grep.py`. Symbol-lookup queries with ground-truth definition files. Numbers are real and reproducible, but scoped to this run — not a universal claim (PRD claim rules apply)._

| metric | grep | ripgrep | AgentRail |
| --- | --- | --- | --- |
| recall (finds the file) | 1.00 | 1.00 | 1.00 |
| precision@1 (definition ranked first) | — | — | **0.83** |
| set-precision | 0.15 | 0.32 | 0.13 |
| tokens to obtain context | 4,673,709 | 189,495 | **3,034** |

AgentRail compact context is **-100% vs grep** and **-98% vs ripgrep** at equal recall.

## Per-query (rank = position of the definition file in AgentRail results)

| query | required | grep recall/prec (n) | rg recall/prec (n) | AgentRail recall/prec (n) | AR rank |
| --- | --- | --- | --- | --- | --- |
| `res.json` | lib/response.js | 1.00/0.06 (16) | 1.00/0.06 (16) | 1.00/0.10 (10) | #1 |
| `res.sendFile` | lib/response.js | 1.00/0.11 (9) | 1.00/0.20 (5) | 1.00/0.14 (7) | #1 |
| `req.accepts` | lib/request.js | 1.00/0.09 (11) | 1.00/0.14 (7) | 1.00/0.10 (10) | #1 |
| `app.listen` | lib/application.js | 1.00/0.03 (34) | 1.00/0.03 (30) | 1.00/0.10 (10) | #1 |
| `createApplication` | lib/express.js | 1.00/0.25 (4) | 1.00/1.00 (1) | 1.00/0.25 (4) | #1 |
| `function View` | lib/view.js | 1.00/0.33 (3) | 1.00/0.50 (2) | 1.00/0.10 (10) | #2 |

## Honest reading
- **Recall ties at 1.00** — for literal-symbol lookups all three find the file.
- **AgentRail's edge is tokens + ranking**, not set-precision: it returns a ranked top-K, so on raw set-precision ripgrep scores higher; that metric is the wrong lens for a ranked retriever.
- **precision@1** (definition ranked first) and **token cost** are the meaningful axes — and the token reduction at equal recall mirrors greplm's headline.
- Conceptual/semantic queries are **not** covered here (embeddings disabled); enable a provider with `agentrail context embed setup` to benchmark that axis.
