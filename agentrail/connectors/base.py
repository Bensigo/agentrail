"""The shared **Connector** interface (M038, AC1).

A connector is the two-way seam between an external tool and the **Issue Queue**
(CONTEXT.md): it *ingests* human-created issues into the queue and *reports
results back*. **Execution-Only Autonomy** — a connector only brings in work a
human defined; it never invents goals.

This is a deep module behind a deliberately tiny surface
(verification-contract-architecture.md): three methods —

- ``ingest()``     — pull external issues and hand the validated ones toward the
  Issue Queue (each adapter runs them through the input-contract gate so an
  issue without machine-checkable acceptance criteria never enters the queue).
- ``post_result(issue_ref, outcome)`` — report a run's terminal outcome back to
  the source issue (the *back* half of the two-way contract).
- ``notify(event)`` — surface a lifecycle event (completed / escalated / blocked)
  on whatever channel the adapter owns.

The interface holds no I/O and no DB/network imports; concrete adapters
(``connectors/github.py`` etc.) own the side effects. The value types here are
plain frozen data so adapters and the orchestrator share one vocabulary.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import FrozenSet, List, Optional

from agentrail.afk.queue_state import QueueEntry


@dataclass(frozen=True)
class IngestedIssue:
    """One external issue after it passed (or failed) the input-contract gate.

    The *result* of ``ingest`` for a single source issue: it was either
    **admitted** to the Issue Queue (``admitted=True`` and ``entry`` is the freshly
    minted :class:`~agentrail.afk.queue_state.QueueEntry`) or **rejected** at the
    gate (``admitted=False`` and ``reason`` says why — e.g. no machine-checkable
    acceptance criteria). Carrying both shapes lets the orchestrator enqueue the
    admitted ones and audit the rejections.
    """

    number: int
    title: str
    admitted: bool
    reason: Optional[str] = None
    entry: Optional[QueueEntry] = None
    url: str = ""


@dataclass(frozen=True)
class IssueRef:
    """A reference to one external source issue (the unit ``poll`` returns).

    The MVP polling intake (GitHub OAuth) lists the labeled open issues and hands
    each back as an ``IssueRef``: enough to (a) feed the body through the
    input-contract gate and (b) address the *back* channel later — ``repo`` +
    ``number`` together locate the issue for ``post_result``. ``url`` is the
    human link. This is the connector's address for an issue, distinct from
    :class:`IngestedIssue` (the gate's verdict on that issue).
    """

    repo: str
    number: int
    title: str = ""
    body: str = ""
    url: str = ""
    labels: FrozenSet[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class OutcomeReport:
    """A run's terminal **Run Outcome** to report back on the source issue.

    ``state`` is the Run-Outcome wording (CONTEXT.md): ``green`` /
    ``escalated-to-human`` / ``blocked``. ``summary`` is a short human line; the
    optional ``url`` links to the PR or run.
    """

    state: str
    summary: str
    url: Optional[str] = None

    def to_comment(self) -> str:
        """Render the outcome as a Markdown comment body (the *back* channel)."""
        head = f"AgentRail run outcome: **{self.state}**"
        lines = [head, "", self.summary]
        if self.url:
            lines += ["", self.url]
        return "\n".join(lines)


@dataclass(frozen=True)
class ConnectorEvent:
    """A lifecycle event a connector may ``notify`` on (completed/escalated/blocked)."""

    kind: str
    issue_number: int
    detail: str = ""


class Connector(ABC):
    """The shared two-way connector interface (AC1).

    Concrete adapters implement all three methods. The interface is intentionally
    minimal so each adapter stays a deep module with a small, stable surface.
    """

    @abstractmethod
    def ingest(self) -> List[IngestedIssue]:
        """Pull external issues and run each through the input-contract gate.

        Returns one :class:`IngestedIssue` per source issue — admitted ones carry
        a :class:`QueueEntry`, rejected ones carry the reason. The adapter does
        the I/O (listing/fetching); the gate (``afk/input_contract``) decides
        admission, so an issue lacking machine-checkable acceptance criteria never
        enters the Issue Queue.
        """
        raise NotImplementedError

    @abstractmethod
    def post_result(self, issue_ref: int, outcome: OutcomeReport) -> None:
        """Report a run's terminal outcome back to the source issue (the *back* half)."""
        raise NotImplementedError

    @abstractmethod
    def notify(self, event: ConnectorEvent) -> None:
        """Surface a lifecycle event on the adapter's channel (may be a no-op)."""
        raise NotImplementedError
