"""Unit tests for the scheduled **Cadence** — the Heartbeat's fallback path.

Behavior-only through the public interface. Vocabulary from CONTEXT.md: the
**Heartbeat** is *event-first* with a **scheduled-cadence fallback** that "scans
the backlog, runs grabbable issues, and posts a triage summary." It "stops when
the queue is empty" — when there is no grabbable work the cadence does nothing
(no summary spam).

The cadence REUSES the event-trigger ``Dispatcher`` (#786) to dispatch grabbable
work and stays gated by the same prerequisite gate; it does not reinvent the
queue. I/O is injected: a ``fetch_body``/``launch_run`` on the dispatcher and an
injectable *connector/notifier* that posts the triage summary. No live network,
no live agent.
"""
from agentrail.afk.queue_state import QueueEntry, QueueState, Terminal, Tier
from agentrail.connectors.base import ConnectorEvent
from agentrail.heartbeat.cadence import (
    Cadence,
    TriageCategory,
    TriageSummary,
)
from agentrail.heartbeat.dispatcher import Dispatcher


# An issue body that passes the Input-Contract gate (has a checkbox AC). Templated
# on the issue number so distinct issues carry distinct content — real issues do,
# and the Input-Contract v2 content-dedup (#1026) parks byte-identical bodies as
# duplicate content. Tests that want a specific body still override it via `bodies`.
def _valid_body(number: int) -> str:
    return f"""## Acceptance criteria
- [ ] AC1: issue #{number} does the thing
"""


# A single valid body, for callers/tests that don't care about the number.
_VALID_BODY = _valid_body(0)

# An issue body the Input-Contract gate rejects (no machine-checkable AC).
_NO_AC_BODY = "Please just make it nicer, thanks."


class _FakeConnector:
    """A fake injectable connector/notifier that records what was posted.

    Stands in for a real notify connector (e.g. the #785 Discord adapter) so the
    cadence can be tested without a live channel.
    """

    def __init__(self):
        self.posted: list[TriageSummary] = []
        self.events: list[ConnectorEvent] = []

    def post_triage_summary(self, summary: TriageSummary) -> None:
        self.posted.append(summary)

    def notify(self, event: ConnectorEvent) -> None:  # pragma: no cover - parity
        self.events.append(event)


def _dispatcher(bodies=None, launched=None):
    bodies = bodies if bodies is not None else {}
    launched = launched if launched is not None else []
    return Dispatcher(
        fetch_body=lambda number: bodies.get(number, _valid_body(number)),
        launch_run=lambda entry: launched.append(entry.number),
    )


# --- AC1: the cadence scans the backlog and dispatches grabbable issues ------


def test_cadence_scans_backlog_and_dispatches_grabbable_issues():
    launched = []
    connector = _FakeConnector()
    cadence = Cadence(dispatcher=_dispatcher(launched=launched), connector=connector)

    # The backlog is the set of issue numbers a connector found grabbable.
    cadence.run(backlog=[101, 102, 103])

    # Every grabbable backlog issue was dispatched to a run (launched).
    assert launched == [101, 102, 103]


def test_cadence_skips_issues_rejected_by_input_contract_gate():
    launched = []
    connector = _FakeConnector()
    d = _dispatcher(bodies={9: _NO_AC_BODY}, launched=launched)
    cadence = Cadence(dispatcher=d, connector=connector)

    cadence.run(backlog=[9, 10])

    # The gate kept #9 out of the queue; only the valid #10 was dispatched.
    assert launched == [10]


def test_cadence_does_not_dispatch_a_parked_blocked_issue():
    launched = []
    connector = _FakeConnector()
    d = _dispatcher(launched=launched)
    cadence = Cadence(dispatcher=d, connector=connector)

    # #5 is blocked by an open #99 → parked → not grabbable → never launched.
    cadence.run(backlog=[5], open_blockers={5: frozenset({99})})

    assert launched == []


# --- AC2: a triage summary is posted (merged / escalated / failed) -----------


def test_cadence_posts_triage_summary_categorized_by_run_outcome():
    connector = _FakeConnector()
    cadence = Cadence(dispatcher=_dispatcher(), connector=connector)

    # A sample set of finished entries spanning all three Run-Outcome terminals.
    finished = [
        QueueEntry(number=1, state=Terminal.GREEN),
        QueueEntry(number=2, state=Terminal.ESCALATED_TO_HUMAN),
        QueueEntry(number=3, state=Terminal.BLOCKED),
    ]

    cadence.run(backlog=[], finished=finished)

    assert len(connector.posted) == 1
    summary = connector.posted[0]
    # Green → merged, Escalated-to-human → escalated, Blocked → failed.
    assert summary.merged == [1]
    assert summary.escalated == [2]
    assert summary.failed == [3]


def test_triage_summary_buckets_each_terminal_under_the_right_category():
    summary = TriageSummary.from_finished(
        [
            QueueEntry(number=11, state=Terminal.GREEN),
            QueueEntry(number=12, state=Terminal.GREEN),
            QueueEntry(number=13, state=Terminal.ESCALATED_TO_HUMAN),
            QueueEntry(number=14, state=Terminal.BLOCKED),
        ]
    )
    assert summary.merged == [11, 12]
    assert summary.escalated == [13]
    assert summary.failed == [14]
    assert summary.is_empty is False


def test_triage_summary_renders_all_three_categories():
    summary = TriageSummary(merged=[1], escalated=[2], failed=[3])
    text = summary.render()
    assert "merged" in text.lower()
    assert "escalated" in text.lower()
    assert "failed" in text.lower()


def test_triage_category_maps_terminals():
    assert TriageCategory.for_terminal(Terminal.GREEN) is TriageCategory.MERGED
    assert (
        TriageCategory.for_terminal(Terminal.ESCALATED_TO_HUMAN)
        is TriageCategory.ESCALATED
    )
    assert TriageCategory.for_terminal(Terminal.BLOCKED) is TriageCategory.FAILED


# --- AC3: the cadence does nothing when there is no grabbable work ------------


def test_cadence_no_op_on_empty_backlog_and_nothing_finished():
    launched = []
    connector = _FakeConnector()
    cadence = Cadence(dispatcher=_dispatcher(launched=launched), connector=connector)

    cadence.run(backlog=[])

    # Stops on empty: nothing dispatched, no summary posted (no spam).
    assert launched == []
    assert connector.posted == []


def test_cadence_no_op_when_backlog_has_only_non_grabbable_work():
    launched = []
    connector = _FakeConnector()
    cadence = Cadence(dispatcher=_dispatcher(launched=launched), connector=connector)

    # Only a parked/blocked issue and nothing finished → no grabbable work.
    cadence.run(backlog=[5], open_blockers={5: frozenset({99})})

    assert launched == []
    assert connector.posted == []


def test_cadence_posts_summary_even_if_nothing_new_dispatched_but_runs_finished():
    launched = []
    connector = _FakeConnector()
    cadence = Cadence(dispatcher=_dispatcher(launched=launched), connector=connector)

    # No grabbable backlog, but earlier runs finished → there is work to report,
    # so a triage summary IS posted (it is not "no work").
    cadence.run(
        backlog=[],
        finished=[QueueEntry(number=1, state=Terminal.GREEN)],
    )

    assert launched == []
    assert len(connector.posted) == 1
    assert connector.posted[0].merged == [1]


def test_cadence_returns_idle_outcome_when_no_grabbable_work():
    cadence = Cadence(dispatcher=_dispatcher(), connector=_FakeConnector())
    outcome = cadence.run(backlog=[])
    assert outcome.dispatched == []
    assert outcome.summary is None
