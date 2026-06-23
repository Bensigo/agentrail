"""Config-driven "does this change require a test/proof?" guardrail — PURE policy.

This is the framework-independent generalisation of issue #907's hardcoded
``verify_gate`` classifier.  #907 baked in "Python source" (``path.endswith('.py')``)
and "pytest" (``test_*.py``); this policy bakes in **nothing**.  It reads a
:class:`Signals` snapshot plus a declared :class:`ProofConfig` (``source_globs`` +
``test_globs``) and decides whether the change touches source that must prove
itself — purely from glob matching.  There is no ``.py`` or ``pytest`` literal in
this file (AC2): hand it a TypeScript config and the SAME code classifies a
``foo.ts`` change as proof-requiring and a docs change as test-free (AC3).

Purity (AC4)
------------
No ``subprocess``/``git``/``gh``/``pytest`` import.  Producing the ``Signals`` is
the adapters' job (:mod:`agentrail.guardrails.adapters`); this module only reads
the neutral data and matches it against globs.

Classification semantics (preserved from #907)
----------------------------------------------
* A path is *test* if it matches any ``test_globs`` pattern.
* A path is *proof-requiring source* if it matches any ``source_globs`` pattern
  and is NOT a test.  (``test_globs`` wins, so a test file under the source tree
  is never counted as needing its own proof — mirrors #907's
  ``is_proof_requiring_source`` excluding ``is_test_file``.)
* ``requires_proof`` is true iff the change touches at least one proof-requiring
  source file.
* ``is_test_free`` is true iff the change is NON-EMPTY and requires no proof — an
  empty change set is deliberately NOT test-free (nothing produced must not waive
  the Red-Green Proof — #907).
"""
from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatch
from typing import Iterable, List, Tuple

from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register
from agentrail.guardrails.signals import Signals


@dataclass(frozen=True)
class ProofConfig:
    """Declares which paths are *source* (need a proof) and which are *tests*.

    Both are tuples of ``fnmatch`` glob patterns matched against repo-relative
    paths, e.g. for Python ``source_globs=("*.py",)`` with
    ``test_globs=("test_*.py", "*_test.py")``; for TypeScript
    ``source_globs=("**/*.ts",)`` with ``test_globs=("**/*.test.ts",)``.

    This is the ONLY framework-specific knob — the policy code below is generic.
    """

    source_globs: Tuple[str, ...]
    test_globs: Tuple[str, ...]


def _matches_any(path: str, patterns: Iterable[str]) -> bool:
    """True iff *path* matches any glob in *patterns*.

    ``fnmatch`` does not treat ``/`` specially, so ``**/*.ts`` matches a nested
    ``a/b/foo.ts`` *and* ``*.ts`` matches a top-level ``foo.ts``.  To make a
    leading ``**/`` ALSO match a top-level path (TS configs conventionally write
    ``**/*.ts`` to mean "any .ts"), the bare tail is tried too.
    """
    base = path.rsplit("/", 1)[-1]
    for pat in patterns:
        if fnmatch(path, pat):
            return True
        # `**/x` should also match a top-level `x` (no directory component).
        if pat.startswith("**/") and fnmatch(path, pat[3:]):
            return True
        # A directory-less pattern (e.g. `test_*.py`) should match by basename so
        # `pkg/test_a.py` is recognised as a test regardless of its directory.
        if "/" not in pat and fnmatch(base, pat):
            return True
    return False


def is_test_path(path: str, config: ProofConfig) -> bool:
    """True iff *path* is a test file under *config*."""
    return _matches_any(path, config.test_globs)


def is_proof_requiring_source(path: str, config: ProofConfig) -> bool:
    """True iff a change to *path* needs a proof under *config*.

    Source by ``source_globs`` AND not a test by ``test_globs``.
    """
    return _matches_any(path, config.source_globs) and not is_test_path(path, config)


def changed_source_files(changed: Iterable[str], config: ProofConfig) -> List[str]:
    return sorted({p for p in changed if is_proof_requiring_source(p, config)})


def changed_test_files(changed: Iterable[str], config: ProofConfig) -> List[str]:
    return sorted({p for p in changed if is_test_path(p, config)})


def requires_proof(signals: Signals, config: ProofConfig) -> bool:
    """True iff *signals* touches source that must prove itself under *config*."""
    return bool(changed_source_files(signals.changed_files, config))


def is_test_free(signals: Signals, config: ProofConfig) -> bool:
    """True iff the change is NON-EMPTY and requires no proof under *config*.

    An empty change set is deliberately NOT test-free (#907): nothing produced
    must not waive the Red-Green Proof.
    """
    return bool(signals.changed_files) and not requires_proof(signals, config)


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ProofRequiredGuardrail:
    """Adapts :func:`requires_proof` to the :class:`Guardrail` protocol.

    ``evaluate(signals=..., config=...)`` returns ``FAIL`` (blocking) when the
    change touches proof-requiring source — i.e. a test/proof is required for
    this change.  A test-free (docs/config-only) change is ``PASS``.  The caller
    that knows whether a proof was actually *supplied* combines this with the
    test results; this guardrail answers only "is a proof required?".
    """

    name: str = "proof_required"
    description: str = (
        "Flags changes that touch declared source globs (and so require a "
        "test/proof) versus changes that are legitimately test-free; "
        "config-driven and framework-neutral."
    )
    blocking: bool = True

    def evaluate(self, **kwargs: object) -> Verdict:
        signals = kwargs.get("signals")
        config = kwargs.get("config")
        if not isinstance(signals, Signals) or not isinstance(config, ProofConfig):
            raise TypeError(
                "ProofRequiredGuardrail.evaluate requires signals=Signals and "
                "config=ProofConfig keyword arguments"
            )
        sources = changed_source_files(signals.changed_files, config)
        if sources:
            return Verdict.failing(
                "change touches source requiring a proof: " + ", ".join(sources)
            )
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
PROOF_REQUIRED_GUARDRAIL = register(ProofRequiredGuardrail())
