# AgentRail Eval Harness

This directory is where we prove what the AgentRail harness actually does and
attribute the result to specific layers. It exists so any developer or agent can
find "this is how we prove the harness works" without asking anyone.

> Status: **Phase 1 (spine) — corpus module only.** Arms, runner, scorer, and
> reporter are tracked in the PRD and land in later slices. This README is a
> placeholder that will grow as those modules arrive.

See the full design in
[`docs/prd/eval-harness-isolated-layer-evals.md`](../docs/prd/eval-harness-isolated-layer-evals.md).

## What is an eval here?

The harness is one shared pipeline (a "spine") that every layer plugs into:

```
frozen corpus → arm runner (sandbox) → hidden-test scorer → N repetitions → report
```

A task is **solved** if and only if its hidden test suite passes. The hidden
tests are stored separately from the task's agent-visible working tree and are
mounted only at scoring time, so the agent never sees the answer key. This is the
single ground truth that cannot be fooled by code that merely looks finished.

## Layout

```
agentrail/evals/
  corpus/        # frozen tasks + hidden answer keys (this slice)
  README.md      # you are here
  # later slices: arms/, runner/, scorer/, reports/
```

## The corpus (`agentrail/evals/corpus/`)

The corpus is the harness's irreplaceable asset. Each task lives in its own
directory:

```
agentrail/evals/corpus/<task_id>/
  task.json          # the task record (validated by agentrail.evals.corpus.loader)
  answer_key/        # the HIDDEN test suite — never handed to the agent
    test_*.py
```

`task.json` carries: the repository pinned at a `commit`, a `prompt`, a
`hiddenTests` reference (the answer key), a ground-truth `requiredContext` set,
and a `difficulty` tag (`easy` / `medium` / `hard`, proxied by required-context
scatter). The loader is pure and deterministic; malformed tasks (missing hidden
tests, missing required-context, bad difficulty tag) are rejected with a clear
error naming the offending field.

### Corpus v0 provenance

Corpus v0 is seeded from AgentRail's **own already-merged, test-bearing PRs**:
the human-accepted version already shipped with its proof, giving us honest
ground truth at low cost. For every task, the hidden test suite under
`answer_key/` is the *actual* test file(s) that merged PR shipped, and the fix
PR's merge commit is recorded in `source.mergeCommit` for provenance.

### Corpus commit pinning (the rule)

**`task.commit` MUST be the PARENT of the fix, never the fix commit itself.**

The hidden tests only measure something if the agent's work is *required*. If
`commit` pinned the merge commit of the PR that shipped the fix, the solution
source would already be on disk at that commit, an **empty diff would pass the
hidden tests**, and the eval would measure nothing (#954). So we pin a *pre-fix*
state instead:

- **Fix adds a new file** (most v0 tasks) → pin the fix merge's first parent
  (`<fix>^1`), i.e. the parent of the file's introduction commit. The file is
  absent there, so an empty diff fails.
- **Fix modifies existing files** → pin the parent of the fix merge (`<fix>^1`)
  so the agent's diff has to reproduce the change.

`tests/evals/test_corpus_pins.py` enforces this in a loop over every task: an
empty diff at `commit` must return `False` (the agent's work is required) and
the reconstructed merged-PR diff must return `True` (the change solves the
hidden tests). `commit` is also asserted to never equal `source.mergeCommit`.

> **Pre-registration.** Tasks are committed *before* any run, so results cannot
> be cherry-picked. Do not edit a task to fit a run's output.

### Loading the corpus

```python
from evals.corpus import load_corpus

for task in load_corpus():
    print(task.name, task.repo, task.commit, task.difficulty)
    print("  prompt:", task.prompt)
    print("  required context:", task.required_context)
    print("  hidden tests:", task.hidden_test_paths)
```

### Adding a task

1. Pick an already-merged, test-bearing PR.
2. Create `agentrail/evals/corpus/<task_id>/answer_key/` and copy in the exact test
   file(s) that PR shipped (extract them at the merge commit).
3. Write `agentrail/evals/corpus/<task_id>/task.json` (see an existing task for the shape).
4. Run `python -m pytest -q tests/evals/` — the loader validates the new task.

## Running the corpus tests

```
python -m pytest -q tests/evals/
```
