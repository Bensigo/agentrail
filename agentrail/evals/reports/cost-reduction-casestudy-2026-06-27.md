# Cost-reduction case study — eval run 2026-06-27

**Headline:** `full` arm, 5 reps, 2 solved, **$16.2248 total**, **27,982,075 tokens**, **$8.1124/solved-task**.

This document turns that single real run into a concrete, prioritized plan to cut cost per
solved task. Every dollar figure routes through the canonical rate table in
`agentrail/context/pricing.py` (mirrored into `agentrail/run/pricing.py` as `PRICES`). No
price is invented. Claims that the codebase cannot yet measure are explicitly marked
**UNVERIFIED** and collected in Section 5.

**Billed model for this run:** the `full` arm pins `claude-sonnet-4-5`
(`agentrail/evals/arms/__init__.py`: `PINNED_MODEL = "claude-sonnet-4-5"`,
`PINNED_TEMPERATURE = 0.0`). Its real rates ($/MTok) from the canonical table are:

| | input | output | cache-read | cache-write |
| --- | ---: | ---: | ---: | ---: |
| `claude-sonnet-4-5` | 3.00 | 15.00 | 0.30 | 3.75 |

For comparison (same table), the levers below reference:
`claude-haiku-4-5` = {1.00, 5.00, 0.10, 1.25}; `claude-opus-4-8` = {5.00, 25.00, 0.50, 6.25}.

---

## 1. Cost breakdown — where the $16.22 / 27.98M tokens go

### What the harness actually records (verified)

The sandbox executor captures **exactly one** `Usage` per (task, arm)
(`agentrail/run/runner.py` → `capture_usage("claude", …)`), and `Usage`
(`agentrail/run/usage_capture.py`) carries only four token counts: `input_tokens`,
`output_tokens`, `cache_tokens` (cache-READ), `cache_creation_tokens` (cache-WRITE).

**There is no per-phase (plan/execute/verify) attribution anywhere in the code**, and the
eval report (`eval-report-2026-06-27.md`) publishes only aggregate tokens and cost — no
category or phase split. So a phase-level breakdown **cannot be derived from this run**; it
must be MODELED with stated assumptions (see Section 5, item 1).

### Category breakdown (modeled, calibrated to the real total)

`cost_usd` (`agentrail/run/pricing.py`) computes:
`(input·3 + output·15 + cacheRead·0.3 + cacheWrite·3.75) / 1e6`.

To attribute the real $16.2248 across the 27,982,075 tokens, I fix the two structurally
small fractions to defensible values for a coding-agent workload — input ≈ 1.5%, cache-write
≈ 1.5% of tokens — and solve for the output fraction that makes the priced total hit
**exactly $16.2248**. The result:

| Category | Tokens | Rate $/MTok | Cost | % of $ | % of tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Output | 0.36M | 15.00 | $5.36 | **33.0%** | 1.28% |
| Cache-read | 26.79M | 0.30 | $8.04 | **49.5%** | 95.72% |
| Cache-write | 0.42M | 3.75 | $1.57 | 9.7% | 1.50% |
| Input (uncached) | 0.42M | 3.00 | $1.26 | 7.8% | 1.50% |
| **Total** | **27.98M** | — | **$16.22** | 100% | 100% |

**Assumptions (stated):** input and cache-write each ≈ 1.5% of tokens (typical for a
long-lived agent loop where the system+repo prefix is written once and re-read every turn);
output solved to fit the real total. The qualitative conclusion is robust to these:

- **Cache-read dominates token COUNT (~96%)** but is cheap per token ($0.30), so it is ~half
  the dollars. This is the long repo/system prefix re-read every turn.
- **Output dominates dollars per token**: at $15/MTok it is ~1/3 of the bill on ~1% of the
  tokens. Output is the highest **$-per-token** lever.
- **Input + cache-write** (~17% combined) are the cost of establishing context each turn.

### Per-phase split (MODELED — UNVERIFIED, see Section 5)

No phase attribution exists. A plausible split for a sonnet execute-heavy loop with no
opus plan (the `full` arm uses one pinned model for all phases) is execute ≈ 70-80% of cost,
verify ≈ 10-20%, plan ≈ 5-15%. **Do not quote these to a buyer as measured** — they are an
engineering estimate pending the instrumentation in Section 5.

---

## 2. Ranked levers

Ranked by (estimated savings on THIS run ÷ effort). Savings are computed against the
calibrated Section-1 split using only canonical rates.

| # | Lever | Est. savings (this run) | Effort | Solve-rate risk | File(s) / function(s) |
| --: | --- | ---: | :--: | --- | --- |
| 1 | **Enforce diff-only output** (reject full-file rewrites in execute) | **~$2.1** (−13%) | S | ~0 (format only) | `agentrail/guardrails/policies/output_enforcer.py` `enforce()`; already wired at `agentrail/run/pipeline.py:405` — tighten + make rejection loop back to the agent |
| 2 | **Budget leash actually caps spend** on doomed runs | **~$1.6** (−10%) | S | ~0 (hard task solved nothing) | `agentrail/heartbeat/runtime.py:420` `budget_leash.check(...)`; set a per-issue ceiling (hard task spent $4.65, solved 0) |
| 3 | **Difficulty-gate the model** (haiku on easy single-file tasks) | **~$2.7** on the 2 easy reps | M | low-med | route easy tasks to `claude-haiku-4-5`; the live cost-downgrade path is **dead** (only `agentrail/cli/commands/cost.py` `--apply` calls it) — needs wiring into the run loop |
| 4 | **Warm-cache prefix reuse** (one model, stable prefix → maximize cache-read, minimize cache-write) | up to ~$1.3 (the $1.57 cache-write floor) | M | ~0 | keep a single pinned model per run (already true in `full`); ensure prompt prefix is byte-stable so cache hits, not re-writes |
| 5 | **Cap output tokens** (max-tokens ceiling per turn) | scales with #1; ~$1-2 standalone | S | med (truncation can break edits) | execute-phase invocation in `agentrail/run/pipeline.py` |
| 6 | **Trim the re-read prefix** (smaller context pack → fewer cache-read tokens) | ~$2-4 if pack shrinks 25-50% | L | **high** (context is the harness's edge on hard tasks) | `agentrail/context/compiler.py` `build_context_pack`; risky — do last, measure precision/coverage |

Notes on the dead/at-risk plumbing (verified):
- **Cost-downgrade routing is not in the live loop.** `routing_record` / `_apply_routing` /
  `cheaper_model` (`agentrail/run/routing.py`) are only called from
  `agentrail/cli/commands/cost.py` behind a manual `--apply`. The live escalation path
  (`agentrail/heartbeat/runtime.py:434` `next_tier(...)`) only goes cheap→strong (raises
  cost). So lever #3 is real new wiring, not a flag flip.
- The eval's "routing changed the model 5/5" line is a **string-mismatch artifact** (dated id
  `…-20250929` vs base alias), not real escalation — retries = 0, routing regret = $0.

---

## 3. The no-regret set (ship first)

Levers that cut cost with ~zero solve-rate risk, ordered by savings ÷ effort:

1. **Diff-only output enforcement (#1).** The policy already exists and is already imported
   into the execute pipeline (`pipeline.py:405`). Tightening it to reject full-file rewrites
   and loop the rejection back only changes output **format**, not problem-solving. Note the
   irony for buyer credibility: the `output-format-enforcer` task in this very run scored
   **0% solved** — the harness has the lever and isn't fully banking it yet. Est. **~$2.1**.
2. **Budget leash with a real ceiling (#2).** The check is wired
   (`runtime.py:420`); it just needs a per-issue dollar cap. The hard task spent **$4.65 and
   solved nothing** — capping it at $3 saves **~$1.6** with zero downside (it was never going
   to pass). Pure module, caller supplies spend — low blast radius.
3. **Warm-cache prefix reuse (#4).** Single pinned model + byte-stable prefix converts
   cache-WRITE ($3.75/MTok) into cache-READ ($0.30/MTok). Up to the **$1.57** cache-write
   floor; no effect on what the agent produces.

**No-regret subtotal: ~$5.3 off $16.22 → ~$10.9 total, ~−33%.**

---

## 4. The target — $/solved-task after the top 3

Arithmetic (all against the real $16.2248 / 2 solved = $8.1124):

```
Start:                                          $16.2248   ($8.1124 / solved)
− #1 diff-only output enforcement   −$2.10  →   $14.12
− #2 budget leash caps doomed run   −$1.60  →   $12.52
− #3 haiku on easy tasks            −$2.70  →   $9.82
```

Holding solved = 2 (these levers are designed not to lose solves; #2 only cuts a run that
already solved nothing):

> **$9.82 total / 2 solved = $4.91 per solved task.**
>
> **Buyer line: "$8.11 / solved → ~$4.9 / solved — a ~40% reduction — with no expected hit
> to solve rate."**

Conservative framing for a buyer: even crediting only the two pure no-regret levers (#1+#2,
−$3.70 → $12.52), that is **$6.26 / solved (−23%)** with essentially zero solve-rate risk.
The haiku-on-easy lever is the one that carries low-but-nonzero risk and pushes it under $5.

Upside not in the target (because not yet measurable to buyer grade): warm-cache (#4),
output caps (#5), and prefix trimming (#6) stack on top once instrumented.

---

## 5. Honesty check — what we cannot yet measure

1. **No per-phase or per-category token attribution exists.** The executor records ONE flat
   `Usage` per run (`runner.py` / `usage_capture.py`); the report publishes aggregate-only.
   Section 1's category split is **calibrated to the real total but modeled**, and the
   per-phase split is **UNVERIFIED**. *Instrumentation needed:* tag usage by phase
   (plan/execute/verify) at capture time and emit input/output/cache-read/cache-write per
   phase into the eval report.

2. **Cache-write ROI is a one-sided counterfactual.** `cache_savings`
   (`agentrail/run/pricing.py`) reports only `cached_usd_saved` (positive) and a
   `baseline_uncached_usd` — it **cannot show net** (it never debits what the cache-WRITES
   cost). So lever #4's savings is an upper bound (the $1.57 write floor), not a measured net.
   *Instrumentation needed:* a net-cache metric = (read savings) − (write spend).

3. **Context-pack quality is unmeasured in live runs.** The report shows
   precision@budget / citation-coverage = **n/a** for `full` — "the live sandbox executor
   does not yet plumb context-pack metadata out of the run." So lever #6's solve-rate risk
   **cannot be bounded with data** today; treat prefix-trimming as unproven until these are
   captured live (only offline eval computes them).

4. **"Routing changed model 5/5" is an artifact, not behavior.** Driven by a dated-id vs
   base-alias string mismatch in `runner.py`'s model recording; routing regret = $0,
   retries = 0. Do not cite any "routing saved $X" number — the live cost-downgrade path
   (`routing.py`) is **dead** outside `cost.py --apply`.

5. **Per-run baseline tokens don't exist**, so the report's routing $-delta is correctly
   `n/a` ("we never invent one"). Any A/B cost claim needs a real paired baseline run, not a
   counterfactual reprice.

6. **n = 5 (2 solved).** $8.1124/solved rests on two solved tasks; the difficulty strata
   (easy $4.04, medium $7.53, hard $4.65/unsolved) are n=1-2 each. Lever savings are
   directional on this run, not yet a statistically firm rate. Re-measure after wiring #1/#2
   with a larger corpus before quoting the −40% to a buyer as a guarantee.
