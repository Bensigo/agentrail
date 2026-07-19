# Langfuse judge calibration report

Generated: 2026-07-15

Score vocabulary: v1 (solved, false_green, verify_verdict, judge_verdict)

Compares the optional shadow-judge score (`judge_verdict`, pushed via `agentrail langfuse push-scores --judge`) against the ground truth each traced run actually carries (`solved` for eval reps, `verify_verdict` for production runs). A rate below n=10 renders as **insufficient data**, never a bare percentage — gated on EACH row's own sample size, not the combined total below.

Total comparable (judge, truth) trace pairs: n=0

## Agreement

| Comparison | Agreement | n |
| --- | ---: | ---: |
| judge_verdict vs solved | no data | n=0 |
| judge_verdict vs verify_verdict | no data | n=0 |

_Insufficient data: only 0 comparable trace pair(s) so far (need >= 10). Push more judge verdicts via `agentrail langfuse push-scores --judge` before trusting either rate above._

## Jace triage verdict vs reality

`triage_verdict` (session-scoped, joined on `metadata.run_id`) vs. the run's real outcome: **blocked** is correct when the run was verify-rejected / terminally failed, **unblocked** when it passed.

| Comparison | Agreement | n |
| --- | ---: | ---: |
| triage_verdict vs reality | insufficient data | n=1 |

- false_blocked (blocked, but the run passed): 0
- false_unblocked (unblocked, but the run failed): 0

_Insufficient data: only 1 comparable run pair(s) (need >= 10)._

## Jace QA verdict vs reality

`qa_verdict` vs. the run's real outcome: **passed** expects a passing run, **issues_found** a failing one; **not_verifiable** is excluded from agreement entirely.

| Comparison | Agreement | n |
| --- | ---: | ---: |
| qa_verdict vs reality | no data | n=0 |

Per-verdict breakdown:

| Verdict | Comparable | Agree |
| --- | ---: | ---: |
| passed | 0 | 0 |
| issues_found | 0 | 0 |
| not_verifiable (excluded) | 0 | n/a |

_Insufficient data: only 0 comparable run pair(s) (need >= 10)._
