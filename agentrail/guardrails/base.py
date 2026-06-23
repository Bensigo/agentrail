"""Core seam types for the guardrails package — pure, framework-neutral.

A *guardrail* is a policy that inspects some inputs and returns a :class:`Verdict`
(pass / fail / advisory + reasons).  Guardrails carry metadata (``name``,
``description``, ``blocking``) so they can be enumerated and rendered by tooling
(e.g. ``agentrail guardrails list`` in #922) without being executed.

Design intent (foundation of the guardrails epic, issues #918–#922)
-------------------------------------------------------------------
* :class:`Verdict` is the single result vocabulary every guardrail speaks.  It is
  a small frozen dataclass with a ``status`` enum (:class:`VerdictStatus`) and an
  immutable tuple of ``reasons``.  Pure: no I/O, no framework imports.
* :class:`Guardrail` is a ``typing.Protocol`` — structural, so a policy does not
  have to inherit anything; it just needs ``name``/``description``/``blocking``
  attributes and an ``evaluate(...) -> Verdict`` method.  ``evaluate`` takes
  ``**kwargs`` so different policies can accept different inputs while sharing one
  enumeration/registration seam.  #919 (framework-neutral Signals/adapters) can
  pass a Signals object as a kwarg without changing this protocol.
* The ``blocking`` flag is the policy's *default* posture (blocking vs advisory).
  The per-evaluation outcome still lives in the :class:`Verdict` status, so a
  blocking guardrail can still return ``ADVISORY`` for a soft finding if it ever
  needs to — the seam does not force the two to agree.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable


class VerdictStatus(str, Enum):
    """The three outcomes a guardrail can report.

    * ``PASS``     — the check is satisfied; nothing to do.
    * ``FAIL``     — the check is violated; a *blocking* guardrail should stop the
      run, an advisory one merely records it.
    * ``ADVISORY`` — a soft finding worth surfacing but never blocking.
    """

    PASS = "pass"
    FAIL = "fail"
    ADVISORY = "advisory"


@dataclass(frozen=True)
class Verdict:
    """Immutable result of evaluating a guardrail.

    Parameters
    ----------
    status:
        One of :class:`VerdictStatus`.
    reasons:
        Human-readable explanations.  Empty for a clean ``PASS``; one or more
        strings for ``FAIL``/``ADVISORY`` describing what and why.
    """

    status: VerdictStatus
    reasons: tuple[str, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        # Normalise any iterable of reasons to an immutable tuple of str so the
        # Verdict stays hashable and callers cannot mutate it.
        if not isinstance(self.reasons, tuple):
            object.__setattr__(self, "reasons", tuple(self.reasons))

    @property
    def passed(self) -> bool:
        """``True`` only for a clean :attr:`VerdictStatus.PASS`."""
        return self.status is VerdictStatus.PASS

    @property
    def failed(self) -> bool:
        """``True`` for :attr:`VerdictStatus.FAIL`."""
        return self.status is VerdictStatus.FAIL

    @property
    def advisory(self) -> bool:
        """``True`` for :attr:`VerdictStatus.ADVISORY`."""
        return self.status is VerdictStatus.ADVISORY

    # Convenience constructors -------------------------------------------------

    @classmethod
    def passing(cls, *reasons: str) -> "Verdict":
        return cls(VerdictStatus.PASS, tuple(reasons))

    @classmethod
    def failing(cls, *reasons: str) -> "Verdict":
        return cls(VerdictStatus.FAIL, tuple(reasons))

    @classmethod
    def advise(cls, *reasons: str) -> "Verdict":
        return cls(VerdictStatus.ADVISORY, tuple(reasons))


@runtime_checkable
class Guardrail(Protocol):
    """Structural contract every registered guardrail satisfies.

    Implementations expose enumeration metadata as plain attributes and a pure
    :meth:`evaluate` returning a :class:`Verdict`.  Because this is a
    ``Protocol``, a policy need not subclass anything — a dataclass or a module
    object with these members is a valid ``Guardrail``.
    """

    #: Stable, machine-friendly identifier, e.g. ``"output_enforcer"``.
    name: str
    #: One-line human description for docs / ``guardrails list``.
    description: str
    #: ``True`` if a ``FAIL`` from this guardrail should block the run;
    #: ``False`` if the guardrail is advisory-only.
    blocking: bool
    #: ``True`` if the policy is framework-neutral — pure, importing no agent
    #: framework (no harness/SDK/CI client); ``False`` if it is coupled to a
    #: specific framework.  Surfaced by ``agentrail guardrails list`` / the docs
    #: generator (#922) so agents can see which rules are portable.
    framework_neutral: bool

    def evaluate(self, **kwargs: object) -> Verdict:
        """Inspect ``kwargs`` and return a :class:`Verdict`.  Must be pure."""
        ...
