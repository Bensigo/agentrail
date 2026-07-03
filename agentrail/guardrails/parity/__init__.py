"""Cross-language gate-parity harness (issue #1042).

The queue entrance is enforced by TWO real implementations that must never
silently disagree — the Python gate (``agentrail.guardrails.policies.input_contract``)
and the TypeScript gate (``packages/db-postgres/src/queries/github_intake.ts``).
Divergence between them reopens a security bypass, so this package provides the
shared machinery that lets a pytest suite AND a vitest suite drive the SAME
language-neutral fixture corpus through their respective REAL gates and compare
verdict-for-verdict.

* :mod:`agentrail.guardrails.parity.emit_verdicts` — runs the REAL Python gate over
  every fixture in the shared corpus and emits a canonical
  ``{fixture_id: {"decision": ..., "reason": ...}}`` map as JSON. It is both an
  importable function (the pytest leg calls it in-process) and a ``python -m``
  entrypoint (the vitest/node leg shells out to it to obtain the Python verdict map
  for a true cross-language diff — the node CI job has python3 preinstalled and the
  pure gate imports with only ``PYTHONPATH=.``, no ``pip install``).

The canonical decision vocabulary is the three-value admission verdict shared by
both gates: ``admit`` / ``park`` / ``reject``. See :mod:`.emit_verdicts` for the
exact mapping from each language's native result type onto these strings.
"""
