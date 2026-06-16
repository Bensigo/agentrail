# Audit 0001: Every Agent Operations Console metric is falsifiable (M034 AC3)

## Why

The **console display rule** (CONTEXT.md / [ADR 0009](../adr/0009-falsifiable-only-console-savings-is-benchmark.md))
states: **no number on the operations console that cannot come back negative.**
A metric that can only ever show the product "winning" is a mirror, not a
measurement. The one-sided **"savings"** surface was the original offender and was
**removed in #776** (M033).

This audit (issue #777, AC3) enumerates every metric currently shown on the
**Agent Operations Console** and records whether it is falsifiable — i.e. whether
a bad system can make it come back below target / negative.

## Method

Walked every dashboard surface under
`apps/console/app/(dashboard)/dashboard/[workspaceId]/` and the API read models
that feed them. For each displayed number, asked one question: **can a worse
system make this number worse?** A rate must be able to fall; a cost must be able
to rise; a count is inventory (not a quality claim) and is exempt from the rule.

## Inventory

### Counts / inventory (not quality claims — rule does not apply)

These are neutral inventory totals, not success metrics. They make no claim that
the system is winning, so the "must be able to go negative" rule does not bind.

| Surface | Metric | Notes |
| --- | --- | --- |
| Overview (`page.tsx`) | Runs, Context Packs, Failures, Review Gates, Repos, Memory items, API Keys, Team/members counts | Inventory counts. |
| Overview | Total cost ($), total tokens | Raw totals (rise with usage); not a one-sided win. |
| Runs / Queue / Failures tables | row listings, attempt counts, budget remaining | Evidence tables. |

### Quality / health metrics (rule applies — all FALSIFIABLE)

| Surface | Metric | Falsifiable? | How it can fail |
| --- | --- | --- | --- |
| **Health** (new, M034) | **Accept rate** = green ÷ attempted | ✅ | Renders **below the 50% health line** (red) for a losing loop. |
| **Health** (new, M034) | **Escalation rate** = escalated ÷ attempted | ✅ | Rises toward 100% as more issues hard-stop to a human. |
| Costs → Cost meter (M033) | **Cost-per-Issue-to-Green** (avg $) | ✅ | Rises when issues take more / costlier runs to reach Green. |
| Costs → Cost meter (M033) | **Cache read-to-creation ratio** | ✅ | Comes back **below 1.0×** (red) when cache writes have not paid off. |
| Costs → Cost optimization | Prompt cache **hit rate** | ✅ | Low hit rate = caching not helping. |
| Costs → Cost optimization | **Output : input ratio** | ✅ | Goes high (warn) when output tokens dominate. |
| Costs → Cost optimization | **Premium-model spend** ($) | ✅ | Rises (warn) when expensive models are over-used. |
| Costs → Agent / model breakdown | per-model **cost** ($) | ✅ | Cost-only; rises with spend. |
| Costs → Anomaly table | cost **anomalies** | ✅ | Surfaces spikes (a bad signal). |
| Scorecard → By runner | **Success rate** | ✅ | Falls for a weak runner. |
| Scorecard → By runner | **Review fix rate**, **Human review rate** | ✅ | Rise when a runner needs more human intervention. |
| Scorecard → By runner | **Cost / merged PR** | ✅ | Rises with waste. |
| Scorecard → By runner | **Context efficiency** | ✅ | Falls when retrieval is wasteful. |
| Context Quality → charts | precision-at-budget, citation coverage, stale/denied leakage | ✅ | Coverage falls / leakage rises for poor retrieval. |
| Context Quality → Rot score | Context-rot score (0–100) | ✅ | Rises (worse) as context goes stale. |

## Findings

1. **No remaining non-falsifiable metric is surfaced on the operations console.**
   Every quality/health number above can come back below target. The one-sided
   "savings" widget was already removed in #776.

2. **One vestigial one-sided figure was found and removed in this PR.** The
   **Cost optimization** panel previously printed a sub-caption
   `"$X saved vs uncached"` (`cache.cachedDollarsSaved`), computed as
   `cacheTokens × (inputRate − cachedReadRate)` — a counterfactual that is
   always ≥ 0 and can never come back negative, the exact pattern ADR 0009
   forbids. It was the *sub*-caption under the falsifiable cache **hit rate**
   headline, not a headline metric, but it still violated the rule. It is now
   replaced with a neutral **cache-token count** (`cache.cacheTokens`), and the
   falsifiable **cache read-to-creation ratio** on the Cost meter remains the
   real caching health signal. The `cachedDollarsSaved` field is no longer
   rendered anywhere on the console.

## Verdict

**PASS.** After removing the `"saved vs uncached"` sub-caption, every metric on
the Agent Operations Console is falsifiable. The vs-**Raw-Agent Baseline**
"20–30%" cost claim remains where ADR 0009 puts it — a separate, dated
validation-benchmark surface, never a live console ticker.
