# Context Retrieval Benchmark

Generated: 2026-06-10T08:50:31.127Z
Fixtures: 1
Invalid fixtures (required source not in repo): none
Token estimator: chars/4
Embedding provider: disabled

_Measured on the benchmark fixture suite. Website claims must follow the PRD claim rules and cite this run, not these numbers as universal._

Required-source inclusion (planner_hybrid): 100%
Selected context tokens: -86% vs current AgentRail baseline
Selected context tokens: -88% vs grep+full-file baseline
Precision at budget: current 1.0 -> planner_hybrid 1.0
Stale/denied/stale-embedding leakage (planner_hybrid): 0/0/0
All pass gates: PASS

| variant | reqInclusion | precision@budget | selectedTokens | fullFileTokens | wasted |
| --- | --- | --- | --- | --- | --- |
| search_full_file_baseline | 100% | 1.0 | 593 | 593 | 0 |
| current | 100% | 1.0 | 503 | 0 | 0 |
| compact_exact | 100% | 1.0 | 69 | 0 | 0 |
| exact_only | 100% | 1.0 | 69 | 0 | 0 |
| semantic_only | 0% | 0.0 | 0 | 0 | 0 |
| always_hybrid | 100% | 1.0 | 69 | 0 | 0 |
| planner_hybrid | 100% | 1.0 | 69 | 0 | 0 |
