# AgentRail Context Engine v2 — Benchmarks

_Measured 2026-06-15 by `agentrail/scripts/benchmark-v2.py`. Exercises v2's symbol graph (`context def`), call graph (`context impact`), and warm daemon — not v1 retrieval. Scoped to the repos below, not universal guarantees._

## Headline (v2)

- **Exact symbol -> definition.** Across 9 symbols (agentrail (4), flask (5)), `context def` returned the correct definition file **first (100% precision@1)**, deterministically (symbol table, not fuzzy ranking).
- **A fraction of the tokens.** Returning the definition's line range cost **3,592 tokens** vs **1,116,204** to grep the symbol and read each matched file in full — **311x fewer (-99.7%)**.
- **Answers call-graph questions grep can't.** `context impact` returned transitive callers for **9/9** symbols — grep/ripgrep return an unordered text match, no graph.
- **Warm in memory.** With the daemon serving the v2 index, `context def` ran at a **257 ms** median vs **526 ms** cold (12 samples).

## Per-symbol (precision@1, def tokens vs grep-full)

| repo | symbol | def #1 | def tokens | grep-full tokens | impact (callers) |
| --- | --- | --- | --- | --- | --- |
| agentrail | `cost_for` | ✅ | 423 | 62,986 | yes |
| agentrail | `query_context` | ✅ | 32 | 299,841 | yes |
| agentrail | `build_context_pack` | ✅ | 6 | 256,118 | yes |
| agentrail | `compute_tokens_saved` | ✅ | 20 | 44,262 | yes |
| flask | `jsonify` | ✅ | 344 | 92,514 | yes |
| flask | `url_for` | ✅ | 1,282 | 150,157 | yes |
| flask | `render_template` | ✅ | 139 | 102,926 | yes |
| flask | `send_file` | ✅ | 1,320 | 65,768 | yes |
| flask | `stream_with_context` | ✅ | 26 | 41,632 | yes |
