# AgentRail eval report

Generated: 2026-06-23

Headline cost metric is **dollars-per-solved-task** (never cost per task). Reports include failures, ties, and spread — not only wins. All dollar figures route through the single-source pricing module.

## Per-arm summary

| Arm | Reps | Solved | Failed | Solve-rate | Spread | Total tokens | Total cost | Dollars-per-solved-task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 10 | 5 | 5 | 50.0% | 0.1000 | 2830000 | $8.5687 | $1.7137 |
| full | 10 | 9 | 1 | 90.0% | 0.1000 | 4895000 | $7.6425 | $0.8492 |
| full-minus-context | 10 | 0 | 10 | 0.0% | 0.0000 | 1152000 | $3.7252 | n/a |

## Failures, ties, and spread

### Arm: baseline

- Failed repetitions: 5 of 10
- Tie tasks (solved on some reps, failed on others): issue-770, issue-922
- Spread (population stddev of per-task solve-rate): 0.1000
- Dollars-per-solved-task: $1.7137
- Per-task solve-rate:
  - issue-770: 40.0%
  - issue-922: 60.0%

### Arm: full

- Failed repetitions: 1 of 10
- Tie tasks (solved on some reps, failed on others): issue-770
- Spread (population stddev of per-task solve-rate): 0.1000
- Dollars-per-solved-task: $0.8492
- Per-task solve-rate:
  - issue-770: 80.0%
  - issue-922: 100.0%

### Arm: full-minus-context

- Failed repetitions: 10 of 10
- Tie tasks: none
- Spread (population stddev of per-task solve-rate): 0.0000
- Dollars-per-solved-task: n/a (undefined — no repetition solved; total cost $3.7252 was spent on failures)
- Per-task solve-rate:
  - issue-770: 0.0%
  - issue-922: 0.0%
