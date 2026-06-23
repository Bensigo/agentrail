"""AgentRail eval harness.

Top-level home for isolated, per-layer evaluation of the AgentRail harness.
See ``evals/README.md`` and ``docs/prd/eval-harness-isolated-layer-evals.md``.

Phase 1 ships the frozen corpus (``evals.corpus``): the harness's irreplaceable
asset. Everything else (arms, runner, scorer, reporter) is plumbing built on top.
"""
