"""Issue Input-Contract guardrail — PURE policy (no I/O).

Migrated verbatim (decision semantics unchanged) from
``agentrail/afk/input_contract.py`` for issue #921.  This is the GATE on entry to
the **Issue Queue**: it decides one falsifiable question — *does this issue carry
machine-checkable acceptance criteria?* — and nothing else.

What "machine-checkable" means here mirrors the ``verify``/check model: an
acceptance criterion is machine-checkable when it can be turned into an objective,
runnable check rather than a human judgement call.  In an issue body that means a
**checkbox acceptance criterion** (``- [ ] ...`` / ``- [x] ...``) under the
issue's Acceptance-criteria section.  Prose alone is not machine-checkable.

What lives here (pure)
----------------------
* :class:`Validated` / :class:`Rejected` — the original result types.
* :func:`validate` — the pure decision: ``issue_body`` → ``Validated | Rejected``.
* :func:`admit_to_queue` — mints a ``QueueEntry`` on a validated issue (the GATE).
* :class:`InputContractGuardrail` — the seam adapter wrapping :func:`validate`.

Input-Contract v2 (issue #1026) — three more checks at the queue entrance
-------------------------------------------------------------------------
The queue entrance is the security boundary of an *execution-only* factory: the
queue is human-fed and the agent never invents its own goals, so every check that
matters happens here, at admission, and nowhere downstream. v2 adds:

* :func:`screen_injection` — heuristics + a deny-list that REJECT prompt-injection
  probes (``ignore previous instructions``, ``you are now`` role-reassignment,
  secret-exfiltration, ``curl … | bash`` RCE, impersonated ``System:`` override).
  An injection probe is a hard REJECT — it never becomes a runnable entry.
* :func:`content_hash` — a deterministic hash of the *normalised* issue body so the
  same content submitted under two different issue numbers is caught as a
  duplicate even though the deterministic per-number entry id differs.
* :class:`WriterClass` + :class:`AdmissionLedger` — per-writer rate limits.  Each
  writer class (``human-github``, ``eval-autoticket``, ``jace``) has its own
  admission budget per window; a writer over its limit has its *subsequent* entries
  PARKED for a human, and other writers are unaffected.

The critical invariant (security-relevant): a failed check never silently drops an
entry and never raises out of the heartbeat loop.  Injection is a REJECT (returns
:class:`Rejected`); duplicate-content and rate-limit failures PARK the entry —
they return a real :class:`QueueEntry` in the PARKED state carrying a
human-readable ``reason`` retrievable as STATE (not a log line), so a human can
review it.  :func:`admit_to_queue` catches and converts, and never raises.

Purity (AC2)
------------
No ``subprocess``/``git``/``gh``/``pytest`` import.  The orchestrator does the I/O
(fetching the body) and the queue wiring; this module only parses the body text.
``agentrail.afk.queue_state`` is pure domain (the queue state machine), imported
only so ``admit_to_queue`` can mint a ``QueueEntry`` — it performs no I/O.
The :class:`AdmissionLedger` is a plain immutable value threaded in by the caller;
this module holds no module-level mutable state, so it stays deterministic.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Dict, FrozenSet, List, Optional, Tuple, Union

from agentrail.afk.queue_state import QueueEntry, QueueState, Tier
from agentrail.guardrails.base import Verdict
from agentrail.guardrails.registry import register


# The Acceptance-criteria section of an issue body (house template + this issue
# both use ``## Acceptance criteria``). Case-insensitive; tolerates 1–6 ``#`` and
# a trailing ``(...)``. Captures until the next heading or end of body.
_AC_SECTION = re.compile(
    r"(?im)^\#{1,6}\s*acceptance\s+criteria\b.*?\n(.*?)(?=^\#{1,6}\s|\Z)",
    re.S,
)

# A markdown checkbox line: ``- [ ] ...`` or ``- [x] ...`` (also ``*``/``+``).
_CHECKBOX = re.compile(r"(?im)^\s*[-*+]\s*\[[ xX]\]\s*(.+?)\s*$")


@dataclass(frozen=True)
class Validated:
    """The issue carries machine-checkable acceptance criteria → admit it.

    ``criteria`` is the list of checkbox AC texts found, in document order, so the
    orchestrator can echo what it accepted (and later map each to a check).
    """

    criteria: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class Rejected:
    """The issue lacks machine-checkable acceptance criteria → keep it out.

    ``missing_ac`` is a human-readable reason for the rejection, suitable for a
    queue-admission audit line or a console rejection notice.
    """

    missing_ac: str


Result = Union[Validated, Rejected]


# ---------------------------------------------------------------------------
# v2 check 1 — injection screening (heuristics + deny-list). Pure. (AC1)
# ---------------------------------------------------------------------------
#
# Each pattern is a compiled regex plus the human-readable reason recorded on a
# reject. The list is intentionally narrow and specific: it targets *directives
# aimed at the agent* (override the gate, reassign the role, exfiltrate secrets,
# run remote code, impersonate a privileged role), NOT any mention of the words
# "agent", "instructions", "secret" or "print" — the negative controls in the
# shared corpus guard against an over-broad deny-list. Matching is
# case-insensitive; a single match is enough to reject.
_INJECTION_PATTERNS: Tuple[Tuple["re.Pattern[str]", str], ...] = (
    (
        re.compile(r"(?i)\bignore\s+(all\s+|any\s+)?(the\s+)?previous\s+instructions?\b"),
        "prompt-injection: 'ignore previous instructions' override directive",
    ),
    (
        re.compile(r"(?i)\bdisregard\s+(your\s+|the\s+|all\s+)?(system\s+prompt|instructions?|objective\s+gate)\b"),
        "prompt-injection: 'disregard system prompt / gate' directive",
    ),
    (
        re.compile(r"(?i)\byou\s+are\s+now\b.*\b(developer\s+mode|unrestricted|no\s+guardrails|dan)\b"),
        "prompt-injection: role-reassignment / jailbreak ('you are now …')",
    ),
    (
        re.compile(r"(?i)\b(developer\s+mode|jailbreak|no\s+guardrails|without\s+(any\s+)?guardrails)\b"),
        "prompt-injection: jailbreak / disable-guardrails directive",
    ),
    (
        re.compile(r"(?i)\bact\s+as\s+(an?\s+)?(unrestricted|uncensored|jailbroken)\b"),
        "prompt-injection: 'act as an unrestricted agent' role directive",
    ),
    (
        re.compile(r"(?i)\bprint\b.*\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|[A-Z0-9_]*SECRET[A-Z0-9_]*|[A-Z0-9_]*TOKEN[A-Z0-9_]*|[A-Z0-9_]*API_?KEY[A-Z0-9_]*)\b"),
        "prompt-injection: secret-exfiltration directive (print a credential / env secret)",
    ),
    (
        re.compile(r"(?i)\b(exfiltrate|leak|dump|reveal)\b.*\b(secret|credential|token|api[_ ]?key|\.env)\b"),
        "prompt-injection: secret-exfiltration directive",
    ),
    (
        re.compile(r"(?i)\bcurl\b[^\n|]*\|\s*(bash|sh|zsh)\b"),
        "prompt-injection: remote-code-execution pattern (curl … | bash)",
    ),
    (
        re.compile(r"(?i)\bwget\b[^\n|]*\|\s*(bash|sh|zsh)\b"),
        "prompt-injection: remote-code-execution pattern (wget … | sh)",
    ),
    (
        re.compile(r"(?im)^\s*(system|assistant|developer)\s*:\s*.*\b(override|auto[- ]?approve|approve|bypass)\b"),
        "prompt-injection: impersonated privileged role trying to override the approval gate",
    ),
    (
        re.compile(r"(?i)\b(override|bypass|skip|disable)\b.*\b(human\s+)?(approval|review)\s+(gate|step|process)?\b.*\b(auto[- ]?approve|do\s+not\s+ask)\b"),
        "prompt-injection: directive to override the human approval / review gate",
    ),
    (
        re.compile(r"(?i)\b(merge|approve|auto[- ]?approve)\b.*\b(without|no|skip(ping)?)\s+review\b"),
        "prompt-injection: directive to merge/approve without review",
    ),
)


def screen_injection(issue_body: str) -> Optional[str]:
    """Screen an issue body for prompt-injection directives (pure). (AC1)

    Returns a human-readable rejection reason for the FIRST matching heuristic /
    deny-list pattern, or ``None`` when the body is clean. An injection probe is a
    hard REJECT at the queue entrance — it must never become a runnable entry — so
    :func:`admit_to_queue` maps a non-``None`` return straight to :class:`Rejected`.

    Deliberately narrow: it targets directives *aimed at the agent* (override the
    gate, reassign the role, exfiltrate secrets, run remote code), not innocent
    mentions of words like "agent" or "secret". The shared fixture corpus's
    negative controls prove the deny-list is not over-broad.
    """
    body = issue_body or ""
    for pattern, reason in _INJECTION_PATTERNS:
        if pattern.search(body):
            return reason
    return None


# ---------------------------------------------------------------------------
# v2 check 2 — content-hash near-duplicate detection. Pure, deterministic. (AC2)
# ---------------------------------------------------------------------------
#
# Collapses runs of whitespace and lowercases so cosmetic differences (re-wrapped
# lines, trailing spaces, case) hash the same, then takes a stable digest. The
# deterministic per-number entry id already dedups an EXACT replay of the same
# issue number; this catches the same *content* re-submitted under a DIFFERENT
# issue number, which the id-based dedup cannot see.
_WS_RUN = re.compile(r"\s+")


def content_hash(issue_body: str) -> str:
    """Deterministic hash of the normalised issue body for near-dup detection (AC2).

    Pure and stable across processes (``sha256`` of the normalised text), so the
    same content always maps to the same hash regardless of issue number, cosmetic
    whitespace, or letter case. Used by :class:`AdmissionLedger` to park a second
    admission of already-seen content.
    """
    normalised = _WS_RUN.sub(" ", (issue_body or "").strip().lower())
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# v2 check 3 — per-writer rate limits. Pure ledger threaded by the caller. (AC3)
# ---------------------------------------------------------------------------

class WriterClass(str, Enum):
    """Who submitted the issue — each class has its own admission rate limit.

    The queue is human-fed; these are the three writers that legitimately push
    work at the entrance. A writer over its per-window limit has its *subsequent*
    entries PARKED (not dropped), and the other writers keep their own budgets.
    """

    HUMAN_GITHUB = "human-github"        # a person labelling an issue on GitHub
    EVAL_AUTOTICKET = "eval-autoticket"  # the eval harness auto-filing tickets
    JACE = "jace"                        # Jace, the upstream ideation→issues coordinator


# Per-writer admissions allowed per ledger window before subsequent entries park.
# Humans get the most headroom; the automated writers are capped tighter because a
# runaway loop is the thing a rate limit exists to contain.
_DEFAULT_RATE_LIMITS: Dict[WriterClass, int] = {
    WriterClass.HUMAN_GITHUB: 30,
    WriterClass.EVAL_AUTOTICKET: 10,
    WriterClass.JACE: 20,
}


@dataclass(frozen=True)
class AdmissionLedger:
    """Immutable record of what the entrance has admitted, for the v2 checks (AC2/AC3).

    Threaded through by the caller (the dispatcher holds the latest ledger) so this
    module keeps no mutable module state and stays deterministic and testable. Two
    facts are tracked:

    * ``seen_hashes`` — content hashes already admitted, for duplicate-content
      detection.
    * ``writer_counts`` — how many entries each writer class has been admitted,
      for per-writer rate limiting.

    Every mutating method returns a NEW ledger (never mutates in place), so callers
    can reason about admission decisions as pure transformations.
    """

    seen_hashes: FrozenSet[str] = frozenset()
    writer_counts: Tuple[Tuple[WriterClass, int], ...] = ()
    rate_limits: Tuple[Tuple[WriterClass, int], ...] = ()

    def _limits(self) -> Dict[WriterClass, int]:
        return dict(self.rate_limits) if self.rate_limits else dict(_DEFAULT_RATE_LIMITS)

    def _counts(self) -> Dict[WriterClass, int]:
        return dict(self.writer_counts)

    def has_content(self, body_hash: str) -> bool:
        """True when this content hash has already been admitted (AC2)."""
        return body_hash in self.seen_hashes

    def rate_limit_exceeded(self, writer: WriterClass) -> bool:
        """True when ``writer`` has already used its whole admission budget (AC3).

        Checked BEFORE recording this admission, so the entry that would be the
        (limit+1)-th is the first to park — the writer's earlier entries admitted
        normally, and its *subsequent* ones park.
        """
        return self._counts().get(writer, 0) >= self._limits()[writer]

    def record_admission(self, *, writer: WriterClass, body_hash: str) -> "AdmissionLedger":
        """Return a new ledger noting one more admission by ``writer`` of this content.

        Recorded for entries that actually enter the queue — QUEUED entries and
        parked-for-blocker entries (they occupy a real slot). A duplicate-content
        or rate-limit PARK does NOT consume budget or register the hash (the caller
        skips recording), so a parked writer never counts against itself twice.
        """
        counts = self._counts()
        counts[writer] = counts.get(writer, 0) + 1
        return replace(
            self,
            seen_hashes=self.seen_hashes | {body_hash},
            writer_counts=tuple(sorted(counts.items(), key=lambda kv: kv[0].value)),
        )


def _acceptance_section(body: str) -> str:
    """Return the issue body's Acceptance-criteria section text, or ``""``.

    Pure. Only the named section counts; checkboxes elsewhere in the body (e.g. a
    task list under "What to build") are not acceptance criteria.
    """
    match = _AC_SECTION.search(body or "")
    return match.group(1) if match else ""


def validate(issue_body: str) -> Result:
    """Decide whether an issue may enter the Issue Queue (pure).

    Returns :class:`Validated` when the issue's Acceptance-criteria section
    contains at least one machine-checkable (checkbox) criterion, else
    :class:`Rejected` with the reason. Pure: takes the issue body text, returns a
    plain result; the orchestrator does the I/O (fetching the body) and the queue
    wiring (only a Validated issue is handed to ``queue_state.admit``).
    """
    section = _acceptance_section(issue_body)
    if not section:
        return Rejected(
            missing_ac="no 'Acceptance criteria' section in the issue body"
        )
    criteria = [m.group(1).strip() for m in _CHECKBOX.finditer(section)]
    criteria = [c for c in criteria if c]
    if not criteria:
        return Rejected(
            missing_ac=(
                "Acceptance criteria are not machine-checkable: no checkbox "
                "criteria the Objective Gate could turn into runnable checks"
            )
        )
    return Validated(criteria=criteria)


@dataclass(frozen=True)
class Admission:
    """The outcome of running the queue-entrance gate over one issue (v2). (AC4)

    Exactly one of ``entry`` / ``rejected`` is set:

    * ``rejected`` — the issue is kept OUT of the queue entirely (missing
      machine-checkable AC, or an injection probe). It never becomes an entry.
    * ``entry`` — a real :class:`QueueEntry`. It is QUEUED (admitted) or PARKED
      with a human-readable ``reason`` (duplicate content, or the writer is over
      its rate limit). A parked entry EXISTS so a human can review it — it is
      never a silent drop.

    ``ledger`` is the next :class:`AdmissionLedger` to thread forward: updated
    (content hash + writer count recorded) when the entry actually took a slot,
    and returned UNCHANGED for a reject or a dup/rate-limit park so a parked
    writer never counts against itself.
    """

    ledger: AdmissionLedger
    entry: Optional[QueueEntry] = None
    rejected: Optional[Rejected] = None

    @property
    def is_rejected(self) -> bool:
        return self.rejected is not None

    @property
    def is_parked(self) -> bool:
        return self.entry is not None and self.entry.state is QueueState.PARKED


def admit_to_queue(
    *,
    number: int,
    issue_body: str,
    tier: Tier = Tier.CHEAP,
    remaining_budget: int = 2,
    blocked_by: FrozenSet[int] = frozenset(),
    writer: WriterClass = WriterClass.HUMAN_GITHUB,
    ledger: Optional[AdmissionLedger] = None,
) -> Union[QueueEntry, Rejected, Admission]:
    """The GATE: run the queue-entrance checks over one issue.

    Enforces CONTEXT.md's rule — *an issue cannot enter the queue without
    machine-checkable acceptance criteria* — plus the Input-Contract v2 checks
    (issue #1026): injection screening, duplicate-content detection, and
    per-writer rate limiting. Order matters and is security-first:

    1. **Injection screen** (:func:`screen_injection`) → :class:`Rejected`. A
       prompt-injection probe is a hard REJECT: it never becomes a runnable entry.
    2. **Machine-checkable AC** (:func:`validate`) → :class:`Rejected` if missing.
    3. **Duplicate content** (:func:`content_hash` + ledger) → a PARKED entry with
       a duplicate-content ``reason``; the second admission of the same content
       (even under a different number) is parked, not run (AC2).
    4. **Per-writer rate limit** (ledger) → a PARKED entry with a rate-limit
       ``reason`` once the writer is over its budget; other writers are unaffected
       (AC3).

    Otherwise mints a QUEUED :class:`QueueEntry` on the queue_state machine (it
    never duplicates that machine; the orchestrator then calls ``queue_state.admit``
    to park it if a ``blocked_by`` dependency is open) and records the admission in
    the ledger.

    Return shape (backwards compatible): when called WITHOUT a ``ledger`` (the
    legacy signature), returns the bare :class:`QueueEntry` or :class:`Rejected`,
    exactly as before — the v2 stateful checks (dup/rate-limit) need a ledger and
    are skipped, but injection screening still applies (it is stateless). When
    called WITH a ``ledger``, returns an :class:`Admission` carrying the entry (or
    rejection) AND the next ledger to thread forward.

    Never raises: a failed check is converted to a reject (injection/AC) or a park
    (dup/rate-limit), so it can never kill the heartbeat loop. Pure: no I/O.
    """
    stateless = ledger is None
    led = ledger if ledger is not None else AdmissionLedger()

    def _result(
        *,
        entry: Optional[QueueEntry] = None,
        rejected: Optional[Rejected] = None,
        next_ledger: Optional[AdmissionLedger] = None,
    ) -> Union[QueueEntry, Rejected, Admission]:
        if stateless:
            # Legacy contract: bare entry / Rejected, no ledger surfaced.
            return rejected if rejected is not None else entry  # type: ignore[return-value]
        return Admission(
            ledger=next_ledger if next_ledger is not None else led,
            entry=entry,
            rejected=rejected,
        )

    try:
        # 1. Injection screen — a hard REJECT (never becomes a runnable entry).
        injection_reason = screen_injection(issue_body)
        if injection_reason is not None:
            return _result(rejected=Rejected(missing_ac=injection_reason))

        # 2. Machine-checkable acceptance criteria (the v1 gate).
        result = validate(issue_body)
        if isinstance(result, Rejected):
            return _result(rejected=result)

        body_hash = content_hash(issue_body)

        # 3. Duplicate-content near-dup detection → PARK (do not run twice).
        if led.has_content(body_hash):
            parked = QueueEntry(
                number=number,
                tier=tier,
                remaining_budget=remaining_budget,
                blocked_by=blocked_by,
                state=QueueState.PARKED,
                reason=(
                    "duplicate content: an issue with identical content is already "
                    "in the queue — parked for human review instead of running twice"
                ),
            )
            # No budget/hash recorded: a parked dup did not take a fresh slot.
            return _result(entry=parked)

        # 4. Per-writer rate limit → PARK subsequent entries for this writer.
        if led.rate_limit_exceeded(writer):
            parked = QueueEntry(
                number=number,
                tier=tier,
                remaining_budget=remaining_budget,
                blocked_by=blocked_by,
                state=QueueState.PARKED,
                reason=(
                    f"rate limit: writer '{writer.value}' exceeded its admission "
                    "limit for this window — parked for human review"
                ),
            )
            return _result(entry=parked)

        # Clean: mint a QUEUED entry and record the admission in the ledger.
        entry = QueueEntry(
            number=number,
            tier=tier,
            remaining_budget=remaining_budget,
            blocked_by=blocked_by,
        )
        return _result(
            entry=entry,
            next_ledger=led.record_admission(writer=writer, body_hash=body_hash),
        )
    except Exception as exc:  # never let a check kill the heartbeat loop
        # Convert any unexpected failure into a PARK for human review — never a
        # silent drop, never a raised exception out of the entrance.
        parked = QueueEntry(
            number=number,
            tier=tier,
            remaining_budget=remaining_budget,
            blocked_by=blocked_by,
            state=QueueState.PARKED,
            reason=f"input-contract check errored, parked for human review: {exc}",
        )
        return _result(entry=parked)


# ---------------------------------------------------------------------------
# Guardrail seam adapter (pure) — registered so `list_guardrails()` sees it.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class InputContractGuardrail:
    """Adapts the queue-entrance policy to the :class:`Guardrail` protocol.

    Blocking guardrail. ``evaluate(issue_body=...)`` runs the two STATELESS
    entrance checks — the injection screen and machine-checkable-AC validation —
    and maps them to a verdict: a prompt-injection probe or missing checkbox AC is
    a ``FAIL`` (kept out of the Issue Queue), a clean house-format issue is a
    ``PASS``. The STATEFUL v2 checks (duplicate content, per-writer rate limit)
    need the :class:`AdmissionLedger` and so live in :func:`admit_to_queue`, which
    the dispatcher calls directly — they cannot be evaluated from a single body in
    isolation.
    """

    name: str = "input_contract"
    description: str = (
        "Admits an issue to the Issue Queue only when it passes the entrance "
        "checks: no prompt-injection directive, and an Acceptance-criteria section "
        "with machine-checkable (checkbox) criteria."
    )
    blocking: bool = True
    framework_neutral: bool = True  # pure policy; imports no agent framework

    def evaluate(self, **kwargs: object) -> Verdict:
        issue_body = str(kwargs.get("issue_body", ""))
        injection_reason = screen_injection(issue_body)
        if injection_reason is not None:
            return Verdict.failing(injection_reason)
        result = validate(issue_body)
        if isinstance(result, Rejected):
            return Verdict.failing(result.missing_ac)
        return Verdict.passing()


# Register the singleton instance at import time so `list_guardrails()` sees it.
INPUT_CONTRACT_GUARDRAIL = register(InputContractGuardrail())
