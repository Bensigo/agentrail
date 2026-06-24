# AgentRail Eval Harness

This directory is where we prove what the AgentRail harness actually does and
attribute the result to specific layers. It exists so any developer or agent can
find "this is how we prove the harness works" without asking anyone.

Everything an eval needs lives under `agentrail/evals/`: the frozen corpus, the
arms, the spine that runs them, and the dated reports they produce. The one
command to run an eval is `agentrail evals run`.

See the full design in
[`docs/prd/eval-harness-isolated-layer-evals.md`](../../docs/prd/eval-harness-isolated-layer-evals.md).

## What an eval is

An **eval** runs a real AgentRail configuration against frozen tasks and scores
each run by the one signal that cannot be faked: a hidden test suite the agent
never saw. The harness is one shared pipeline (the "spine") that every layer
plugs into:

```
frozen corpus → arm runner (sandbox) → hidden-test scorer → N repetitions → reporter (markdown + Postgres)
```

- **Corpus** — frozen tasks, each pinned to a repo + commit, with a prompt and a
  hidden answer key (`agentrail/evals/corpus/`, loaded by
  `agentrail.evals.corpus.loader`).
- **Arm runner** — executes one `(task, arm)` pair in an isolated sandbox workdir
  and returns a `RunRecord` (the agent's diff, token usage, model, wall time, and
  the run's own Objective-Gate decision). The runner asserts the answer key is
  absent from the workdir before and after the agent runs, then tears the workdir
  down (`agentrail.evals.runner`, `agentrail.evals.run_record`).
- **Hidden-test scorer** — `ProductionHiddenTestRunner` clones the repo at the
  task's pinned commit into a **separate** workspace, applies the agent's diff,
  copies in the hidden answer key, and runs it. A task is **solved** if and only
  if those hidden tests pass. The answer key is mounted only at scoring time,
  in a workspace the agent never touched, after the agent's workdir is already
  gone — never during the run (`agentrail.evals.hidden_tests`,
  `agentrail.evals.scorer`).
- **N repetitions** — every `(task, arm)` pair is run `--reps` times (default 5)
  so a flaky harness reads differently from a reliable one.
- **Reporter** — aggregates per arm, writes a dated markdown report under
  `agentrail/evals/reports/`, and hands the same numbers to a `MetricsWriter` for
  Postgres (`agentrail.evals.reporter`). All dollar figures route through
  `agentrail.evals.pricing_adapter`, which delegates to the single-source pricer
  so eval dollars never drift from production dollars.

`solved` is defined **solely** by the hidden tests. The run's own Objective-Gate
decision never changes whether a task is solved — it only feeds the *false-green*
probe (gate said "done", hidden tests disagreed). That gap is the most
operationally important number the harness produces.

### Metrics the reporter produces

Per arm (`render_markdown` in `reporter.py`):

- **Solve-rate** (mean over all repetitions) and **spread** (population stddev of
  the per-task solve fractions).
- **Dollars-per-solved-task** — the headline cost metric: total cost over solved
  repetitions, never cost-per-task (which rewards failing cheaply). An all-failure
  arm reports `n/a`, never a crash.
- **Objective-Gate false-green rate** — of the runs whose gate passed, the
  fraction whose hidden tests failed. `n/a` (not `0%`) when no run's gate passed.
- **Per-layer leave-one-out deltas** — for each layer, `full` solve-rate minus
  `full-minus-<layer>` solve-rate on the same run set. A positive delta means the
  layer earns its place; a zero or negative delta flags it to fix or remove.
- **Difficulty strata** — solve-rate / cost / dollars-per-solved broken out per
  `easy` / `medium` / `hard`, in addition to the aggregate.

The **intrinsic probes** (`agentrail evals probes`, `render_probes_markdown`)
measure what hidden tests cannot see: routing cost-regret, retry lift, and the
guardrail injection-corpus catch-rate.

## Layout

```
agentrail/evals/
  corpus/          # frozen tasks + hidden answer keys
  arms/            # declarative arm configs (baseline, full, full-minus-<layer>)
  reports/         # dated markdown reports (eval-report-<date>.md)
  runner.py        # execute one (task, arm) in the sandbox -> RunRecord
  run_record.py    # the RunRecord contract
  scorer.py        # solved iff hidden tests pass; false-green
  hidden_tests.py  # ProductionHiddenTestRunner (apply diff at pinned commit)
  reporter.py      # aggregate -> markdown + Postgres rows
  pricing_adapter.py
  probes.py        # routing regret, retry lift, guardrail catch-rate
  spine.py         # the orchestrator that ties it all together
  README.md        # you are here
```

The CLI surface lives in `agentrail/cli/commands/evals.py`.

## How to run one

One command runs the spine. The default runs the `baseline` and `full` arms over
the frozen corpus v0 with 5 repetitions each:

```
agentrail evals run
```

Flags (`agentrail evals run --help`):

| Flag | Effect |
| --- | --- |
| `--corpus DIR` | Override the corpus root (default: bundled v0). |
| `--task NAME` | Restrict to one task; repeatable, or comma-separated. |
| `--arm NAME` | Add an arm; repeatable. Accepts `baseline`, `full`, `full-minus-<layer>`, `new-flow`, or `new-flow-minus-<layer>` (see [The new flow](#the-new-flow-warm-cache--cheap-critic--best-of-n)). Default: `baseline` + `full`. |
| `--ablation` | Run the full leave-one-out set: `baseline`, `full`, and one `full-minus-<layer>` arm per layer (so per-layer deltas have every arm they need). |
| `--reps N` | Repetitions per `(task, arm)` (default 5, min 1). |
| `--concurrency N` | Run up to N `(task, arm, rep)` units in parallel (default 4, min 1; or `AGENTRAIL_EVAL_CONCURRENCY`). Units are independent, so this cuts a full run from the sum of all units to ~the slowest single unit, bounded by the agent API rate limit. |
| `--include-held-out` | Include the held-out task split (excluded by default so the harness is never developed against it). |

> A long run is resilient: the dated report is re-written after **each** unit
> completes (a killed run still leaves a scorecard for everything that finished),
> and a single unit that crashes is scored as an unsolved failure instead of
> aborting the whole run.

Examples:

```
# Full leave-one-out ablation over the whole corpus
agentrail evals run --ablation

# One task, two named arms, 3 reps each
agentrail evals run --task precision-at-budget --arm full --arm full-minus-context --reps 3
```

Each run prints the run id, the markdown report path, a per-arm summary line, and
whether Postgres persistence succeeded. (The eval-metrics ingest route is owned
by a later issue; persistence honestly reports "no" until it lands, rather than
claiming a false-green persist.)

### Reading a report

Reports are written to `agentrail/evals/reports/eval-report-<date>.md` and
committed, so they are auditable in git and ordered chronologically. Each report
contains:

- **Per-arm summary** — reps, solved, failed, solve-rate, spread, false-green
  rate, total tokens, total cost, dollars-per-solved-task.
- **Per-layer ablation deltas** — `full` minus `full-minus-<layer>` per layer,
  with a verdict (`earns its place` / `FLAGGED: candidate to fix or remove`).
  `n/a` when the run set lacked the arm needed for that delta — so for layer
  deltas, run `--ablation` (or supply the `full-minus-<layer>` arms yourself).
- **Difficulty-stratified breakdown** — the same metrics per `easy` / `medium` /
  `hard`.
- **Failures, ties, and spread** — per arm, including the tasks the harness flips
  on (solved on some reps, failed on others). Failures and ties are surfaced
  alongside wins, not hidden.

### Intrinsic probes

```
agentrail evals probes
```

Renders the intrinsic-probe section. The guardrail catch-rate is always available
(it runs the real guardrails against a built-in injection corpus and needs no
agent run); routing cost-regret and retry lift are computed from per-run records
collected during a spine run.

## Add a task

A task is a frozen, pre-registered unit of ground truth. Corpus v0 is seeded from
AgentRail's **own already-merged, test-bearing PRs**: the human-accepted version
already shipped with its proof, so the hidden answer key is the *actual* test
file(s) that PR merged.

### Layout

```
agentrail/evals/corpus/<task_id>/
  task.json          # the task record (validated by agentrail.evals.corpus.loader)
  answer_key/        # the HIDDEN test suite — stored SEPARATELY from the
    test_*.py        #   agent-visible tree; never handed to the agent
  workdir/           # the agent-visible working tree (agentVisibleRoot)
```

The hidden answer key goes under `answer_key/` (any directory **outside** the
agent-visible tree). The loader **rejects** a task whose hidden-test root sits
under `agentVisibleRoot`, so the answer key can never leak into the agent's
context.

### Steps

1. Pick an already-merged, test-bearing PR.
2. Create `agentrail/evals/corpus/<task_id>/answer_key/` and copy in the exact
   test file(s) that PR shipped (extract them at the merge commit). These are the
   hidden tests; keep them **out** of `agentVisibleRoot`.
3. Write `agentrail/evals/corpus/<task_id>/task.json` with the required fields
   below. Copy an existing task (e.g. `corpus/precision-at-budget/task.json`) for
   the exact shape.
4. Run `python -m pytest -q tests/evals/` — the loader validates the new task and
   `test_corpus_pins.py` enforces the commit-pinning rule.

### Required `task.json` fields

| Field | Meaning |
| --- | --- |
| `name` | Task id (matches the directory name; used by `--task`). |
| `repo` | Repository the task is pinned to, e.g. `"Bensigo/agentrail"`. |
| `commit` | Commit the repo is pinned at — **the parent of the fix** (see rule below). |
| `prompt` | What the agent is asked to do. |
| `agentVisibleRoot` | Relative path of the tree the agent works in (e.g. `"workdir"`). The answer key must NOT live under this path. |
| `hiddenTests` | Object `{"root": "answer_key", "files": ["test_x.py", ...]}` — the hidden answer key. At least one file; each must resolve to a real file on disk. |
| `requiredContext` | Ground-truth required-context set (at least one source path). |
| `difficulty` | One of `easy` / `medium` / `hard` (proxied by required-context scatter). |

Optional:

| Field | Meaning |
| --- | --- |
| `heldOut` | Boolean (default `false`). When `true`, the task is reserved from the dev set — excluded from `load_corpus` and from runs unless `--include-held-out` is passed — so the harness is never tuned against it. Must be a real bool, not the string `"true"`. |
| `source` | Provenance object, e.g. `{"pr": 913, "issue": 901, "mergeCommit": "<sha>", "fixParent": "<sha>"}`. Recommended for v0 tasks. |

A malformed task is rejected by the loader with a `CorpusError` that names the
offending field.

### Commit pinning (the rule)

**`task.commit` MUST be the PARENT of the fix, never the fix commit itself.**

The hidden tests only measure something if the agent's work is *required*. If
`commit` pinned the merge commit of the PR that shipped the fix, the solution
source would already be on disk at that commit, an **empty diff would pass the
hidden tests**, and the eval would measure nothing. So we pin a *pre-fix* state
instead:

- **Fix adds a new file** (most v0 tasks) → pin the fix merge's first parent
  (`<fix>^1`), i.e. the parent of the file's introduction commit. The file is
  absent there, so an empty diff fails.
- **Fix modifies existing files** → pin the parent of the fix merge (`<fix>^1`)
  so the agent's diff has to reproduce the change.

`tests/evals/test_corpus_pins.py` enforces this in a loop over every task: an
empty diff at `commit` must return `False` (the agent's work is required) and the
reconstructed merged-PR diff must return `True` (the change solves the hidden
tests). `commit` is also asserted to never equal `source.mergeCommit`.

> **Pre-registration.** Tasks are committed *before* any run, so results cannot
> be cherry-picked. Do not edit a task to fit a run's output.

### Loading the corpus

```python
from agentrail.evals.corpus.loader import load_corpus

for task in load_corpus():  # held-out tasks excluded by default
    print(task.name, task.repo, task.commit, task.difficulty)
    print("  prompt:", task.prompt)
    print("  required context:", task.required_context)
    print("  hidden tests:", task.hidden_test_paths)

# Include the held-out split (the deliberate "score held-out" pass):
all_tasks = load_corpus(include_held_out=True)
```

## Add an arm

An **arm** is one configuration of the harness run against the same corpus tasks.
Arms are pure declarative data (`agentrail/evals/arms/__init__.py`): each names
the arm, records the on/off state of every AgentRail layer, and pins the model +
temperature. The model, temperature, and every other layer are held fixed so a
leave-one-out arm isolates exactly one layer.

The layers, in fixed order (`LAYER_NAMES`):

```
context      — context retrieval / packing
routing      — model routing / escalation
verify_gate  — the Objective Gate
retry        — the retry loop
guardrails   — the safety/existence guardrails
```

Two anchor arms are always present:

- `baseline()` — every AgentRail layer OFF (the Raw-Agent Baseline).
- `full()` — every AgentRail layer ON.

A leave-one-out arm is one declarative call: `full_minus("<layer>")` returns
`full` with exactly that one layer disabled. `ablation_arms()` enumerates one
`full-minus-<layer>` per layer; `all_arms()` is `baseline`, `full`, then the
ablation arms — the set `--ablation` runs.

### Adding an ablation arm for a new layer

When a new AgentRail layer is added to the harness, make it evaluable in **two
edits** to `agentrail/evals/arms/__init__.py`:

1. Add the layer's name to `LAYER_NAMES`.
2. Add the matching boolean field to the `Layers` dataclass.

That is the whole change. Because everything downstream iterates `LAYER_NAMES`:

- `full_minus("<new_layer>")` and the `full-minus-<new_layer>` arm work
  immediately,
- `ablation_arms()` / `all_arms()` pick the new arm up automatically, so
  `agentrail evals run --ablation` runs it,
- `resolve_arm("full-minus-<new_layer>")` accepts it on the CLI (`--arm`), and
- `reporter.layer_deltas` computes the new layer's leave-one-out delta.

```python
from agentrail.evals.arms import full_minus, ablation_arms, all_arms

full_minus("context")   # full with the context layer disabled
ablation_arms()         # one full-minus-<layer> per layer, in LAYER_NAMES order
all_arms()              # baseline, full, then every ablation arm
```

`full_minus` raises `ValueError` for an unknown layer name, so a typo surfaces
clearly rather than silently producing a wrong arm.

## The new flow (warm-cache + cheap-critic + best-of-N)

The pipeline historically ran every task through **three cold agent phases** —
test-author → execute → verify — where each phase is a fresh agent process that
re-loads the task context from scratch and the verify phase uses a *separate,
expensive* model. Per-task that is ~15–19 min of real agent work, which is also
why a full eval run is slow. The **new flow** cuts that cost/latency without
weakening any anti-false-green guarantee. Design + evidence:
[`docs/prd/warm-cache-cheap-critic-flow.md`](../../docs/prd/warm-cache-cheap-critic-flow.md).

Three layers make up the new flow (each is independently toggleable, each is
ablatable by the eval):

- **`warmcache`** (`AGENTRAIL_EVAL_LAYER_WARMCACHE`, **default ON**) — hoists the
  shared per-task context (issue + context pack + base instructions) to a stable
  *leading* prompt prefix reused across phases, so later phases hit the agent's
  prompt-prefix cache instead of re-sending cold context. Roles stay separate —
  the test-author and executor are **not** merged into one conversation (that
  would yield tautological tests); only the cache prefix is shared.
- **`critic`** (`AGENTRAIL_EVAL_LAYER_CRITIC`, **opt-in**) — a cheap-model Critic
  (default Haiku) replaces the *expensive* verify model as the **independent**
  reviewer feeding the Objective Gate. The Critic is a separate step from the
  executor (never grades its own work) and emits the **same** gate evidence
  shape, so the gate's accept/reject contract is unchanged. Opt-in: it only runs
  when a critic model is configured, so the live loop is unchanged until enabled.
- **`bestofn`** (`AGENTRAIL_EVAL_LAYER_BESTOFN`, **opt-in**) — the execute phase
  produces up to N candidate fixes (default 3, `AGENTRAIL_BESTOFN_N`), the Critic
  ranks them, and the loop **stops early** the moment a candidate is accepted —
  replacing the blind fixed retry loop. Reuses the same independent Critic.

The hidden-test scorer and the Objective Gate's definition of "done" are **never**
touched by any of these layers — they remain the un-foolable ground truth.

### Measuring the new flow (the A/B)

Two arms make the comparison (`agentrail/evals/arms/__init__.py`):

- `full` — today's flow (unchanged).
- `new-flow` — `full` PLUS critic + best-of-N + warm-cache, with a cheap critic
  model pinned (distinct from the execute model). Ablations
  `new-flow-minus-{critic,bestofn,warmcache}` turn exactly one layer off relative
  to the new flow, so each layer's contribution is isolated.

```
# Head-to-head: today's flow vs the new flow over the whole corpus
agentrail evals run --arm full --arm new-flow --reps 1 --concurrency 8

# Per-layer contribution of the new flow
agentrail evals run --arm new-flow \
  --arm new-flow-minus-critic --arm new-flow-minus-bestofn --arm new-flow-minus-warmcache
```

The dated report adds a **New-flow vs full** table comparing the four decision
metrics — dollars-per-solved, wall-time per task, solve-rate, and false-green
rate — and a **New-flow per-layer ablation** table. Every number is falsifiable:
solve-rate and false-green can drop, wall-time and dollars can rise.

### Success gates (before the new flow becomes default)

The new flow becomes the pipeline default **only** when a dated report on the real
corpus shows it meets ALL of:

1. **lower** dollars-per-solved than `full`,
2. **lower** wall-time per task than `full`,
3. solve-rate **≥** `full`, and
4. false-green rate **≤** `full`.

Until that report exists and a maintainer approves it, `critic` and `bestofn`
stay opt-in (the live loop runs today's flow). That go/no-go is deliberately a
human decision — the loop does not flip its own default.

## Running the eval tests

```
python -m pytest -q tests/evals/
```
