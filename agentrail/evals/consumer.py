"""Consumer/apply core: dated eval report → proposed flag/routing changes (issue #1048).

This module closes the eval loop's last seam (PRD
``docs/prd/eval-loop-closure-canary-regression-gate.md`` item 4): it reads a
dated eval report (the #1041 canary output rendered by
:mod:`agentrail.evals.reporter`), derives concrete change proposals, and —
only behind an explicit apply step — writes them:

- ``.agentrail/layer-overrides.json`` pins (consumed live by
  :func:`agentrail.run.pipeline.layer_enabled` via
  :mod:`agentrail.run.layer_overrides`), and
- ``routing --apply`` model steps (the same
  :func:`agentrail.run.routing._apply_routing` write ``agentrail cost
  --routing --apply`` performs).

Three invariants, straight from the PRD's risk list:

1. **Proposal-by-default.** :func:`build_proposal` and
   :func:`render_proposal` are pure; nothing here writes until
   :func:`apply_proposal` is called, and the CLI only calls that under an
   explicit ``--apply``.
2. **Exactly as proposed.** The proposal carries the verbatim overrides-file
   content and routing edits; :func:`apply_proposal` writes that content, not
   a recomputation.
3. **Fail-closed apply.** :func:`apply_proposal` refuses (raises
   :class:`ApplyAuthError`) when the target has no configured server link —
   BEFORE looking at what would be written, even for an empty proposal. This
   is the opposite of the GitHub webhook's fail-open skip
   (``verifySignature`` returning true when its secret is unset): an
   unconfigured secret here rejects, never skips.

Evidence discipline: every proposed change is printed with the report lines
that justify it, and a report without defined evidence (``n/a`` deltas, the
both-arms sentinel, ``$0.0000`` regret) proposes nothing — the loop never
invents evidence.

The first real consumer is the #981 HITL default-flip: when a canary report
shows the new flow passing all four #981 AC1 gates (solve-rate ≥ full, lower
dollars-per-solved, lower wall-time, false-green ≤ full), the proposal pins
``critic``/``bestofn``/``warmcache`` to ``true`` — the recorded human go
decision. A definably regressing report proposes ``false`` instead: the same
lever, pointed the other way.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from agentrail.context.snapshot_push import load_link
from agentrail.evals.arms import NEW_FLOW_LAYERS
from agentrail.run.layer_overrides import overrides_path
from agentrail.run.routing import _apply_routing, cheaper_model


class ReportParseError(ValueError):
    """The given file is not a rendered eval report (no known section anchors)."""


class ApplyAuthError(RuntimeError):
    """Apply refused: the target's auth (server link) is unconfigured.

    Fail-closed by design — contrast with the GitHub webhook's fail-open
    ``if (!secret) return true`` skip, which this family must never copy.
    """


# --- Report facts (parse output) ------------------------------------------

_NEW_FLOW_HEADER = "## New-flow vs full"
_ROUTING_REGRET_HEADER = "## Routing cost-regret"
_SENTINEL_PREFIX = "_Not available:"
_REGRET_LINE_PREFIX = "- Total routing cost-regret:"
_NET_DELTA_LINE_PREFIX = "- Net $-delta vs baseline:"

# Table-row labels in the `## New-flow vs full` section, in render order.
NEW_FLOW_ROW_LABELS = (
    "Solve-rate",
    "Dollars-per-solved-task",
    "Wall-time per task",
    "False-green rate",
)


@dataclass
class NewFlowFacts:
    """The `## New-flow vs full` section, reduced to deltas + raw evidence."""

    available: bool = False
    sentinel: Optional[str] = None
    rows: Dict[str, str] = field(default_factory=dict)  # label -> raw row line
    solve_rate_delta: Optional[float] = None
    dollars_per_solved_delta: Optional[float] = None
    wall_time_delta: Optional[float] = None
    false_green_rate_delta: Optional[float] = None


@dataclass
class RoutingFacts:
    """The routing cost lines, kept raw for evidence plus parsed values."""

    regret_line: Optional[str] = None
    total_regret_usd: Optional[float] = None
    net_delta_line: Optional[str] = None
    net_delta_usd: Optional[float] = None


@dataclass
class ReportFacts:
    path: Path
    name: str
    new_flow: NewFlowFacts
    routing: RoutingFacts


# --- Reverse parsers for reporter.py's _fmt_* helpers ----------------------

_SIGNED_PCT_RE = re.compile(r"^([+-])(\d+(?:\.\d+)?)%$")
_SIGNED_USD_RE = re.compile(r"^([+-])\$(\d+(?:\.\d+)?)$")
_SIGNED_SECONDS_RE = re.compile(r"^([+-]?)(\d+(?:\.\d+)?)s$")
_USD_RE = re.compile(r"\$(\d+(?:\.\d+)?)")


def _parse_signed_pct(cell: str) -> Optional[float]:
    """``"+3.2%"`` → 0.032; ``"n/a"`` or anything else → None."""
    m = _SIGNED_PCT_RE.match(cell.strip())
    if m is None:
        return None
    value = float(m.group(2)) / 100.0
    return -value if m.group(1) == "-" else value


def _parse_signed_usd(cell: str) -> Optional[float]:
    """``"-$0.3400"`` → -0.34; ``"n/a"`` or anything else → None."""
    m = _SIGNED_USD_RE.match(cell.strip())
    if m is None:
        return None
    value = float(m.group(2))
    return -value if m.group(1) == "-" else value


def _parse_signed_seconds(cell: str) -> Optional[float]:
    """``"-4.0s"`` → -4.0; ``"n/a"`` or anything else → None."""
    m = _SIGNED_SECONDS_RE.match(cell.strip())
    if m is None:
        return None
    value = float(m.group(2))
    return -value if m.group(1) == "-" else value


def _row_cells(line: str) -> List[str]:
    """Markdown table row → stripped cells (empty edge cells dropped)."""
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_report(path: Path) -> ReportFacts:
    """Parse a rendered eval report into the facts the proposal rules need.

    Anchors on :mod:`agentrail.evals.reporter`'s exact render strings; scoped
    to the ``## New-flow vs full`` section because the rerank-ablation section
    renders identically-labeled rows. Raises :class:`ReportParseError` when
    NEITHER the new-flow header nor the routing cost-regret header is present
    (the file is not an eval report at all); a missing individual section just
    yields absent evidence, which proposes nothing.
    """
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()

    has_new_flow_header = any(line.strip() == _NEW_FLOW_HEADER for line in lines)
    has_routing_header = any(
        line.strip() == _ROUTING_REGRET_HEADER for line in lines
    )
    if not has_new_flow_header and not has_routing_header:
        raise ReportParseError(
            f"{path} is not an eval report: neither the "
            f"'{_NEW_FLOW_HEADER}' nor the '{_ROUTING_REGRET_HEADER}' "
            "section is present."
        )

    new_flow = NewFlowFacts(available=False)
    section: Optional[str] = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("## "):
            section = stripped
            continue
        if section != _NEW_FLOW_HEADER:
            continue
        if stripped.startswith(_SENTINEL_PREFIX):
            new_flow.sentinel = stripped
            continue
        if stripped.startswith("|"):
            cells = _row_cells(stripped)
            if not cells or cells[0] not in NEW_FLOW_ROW_LABELS:
                continue
            label = cells[0]
            new_flow.rows[label] = stripped
            delta_cell = cells[-1] if len(cells) >= 4 else "n/a"
            if label == "Solve-rate":
                new_flow.solve_rate_delta = _parse_signed_pct(delta_cell)
            elif label == "Dollars-per-solved-task":
                new_flow.dollars_per_solved_delta = _parse_signed_usd(delta_cell)
            elif label == "Wall-time per task":
                new_flow.wall_time_delta = _parse_signed_seconds(delta_cell)
            elif label == "False-green rate":
                new_flow.false_green_rate_delta = _parse_signed_pct(delta_cell)
    new_flow.available = len(new_flow.rows) == len(NEW_FLOW_ROW_LABELS)

    routing = RoutingFacts()
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(_REGRET_LINE_PREFIX):
            routing.regret_line = stripped
            rest = stripped[len(_REGRET_LINE_PREFIX):].strip()
            m = _USD_RE.match(rest)
            routing.total_regret_usd = float(m.group(1)) if m else None
        elif stripped.startswith(_NET_DELTA_LINE_PREFIX):
            routing.net_delta_line = stripped
            rest = stripped[len(_NET_DELTA_LINE_PREFIX):].strip()
            if rest.startswith("n/a"):
                routing.net_delta_usd = None
            else:
                routing.net_delta_usd = _parse_signed_usd(rest.split(" ", 1)[0])

    return ReportFacts(
        path=path, name=path.name, new_flow=new_flow, routing=routing
    )


# --- Proposal building ------------------------------------------------------


@dataclass
class LayerChange:
    """One pin to write into ``.agentrail/layer-overrides.json``."""

    name: str  # lower-case file key, e.g. "critic"
    value: bool


@dataclass
class RoutingChange:
    """One ``runners.<agent>.models.<phase>`` model step-down."""

    agent: str
    phase: str
    current_model: str
    proposed_model: str


@dataclass
class Proposal:
    report_name: str
    report_path: Path
    layer_changes: List[LayerChange] = field(default_factory=list)
    overrides_content: Optional[dict] = None  # exact JSON --apply writes
    layer_notes: List[str] = field(default_factory=list)
    layer_evidence: List[str] = field(default_factory=list)
    routing_changes: List[RoutingChange] = field(default_factory=list)
    routing_notes: List[str] = field(default_factory=list)
    routing_evidence: List[str] = field(default_factory=list)

    @property
    def has_changes(self) -> bool:
        return bool(self.layer_changes or self.routing_changes)


# The four #981 AC1 gates. Delta convention is the reporter's: new-flow minus
# full; higher is better ONLY for solve-rate. Each gate is three-valued:
# "pass" / "fail" (delta defined, wrong side) / "unknown" (n/a in the report).
_GATES: Tuple[Tuple[str, str, str], ...] = (
    ("Solve-rate", "solve_rate_delta", ">= 0"),
    ("Dollars-per-solved-task", "dollars_per_solved_delta", "< 0"),
    ("Wall-time per task", "wall_time_delta", "< 0"),
    ("False-green rate", "false_green_rate_delta", "<= 0"),
)


def _gate_state(rule: str, delta: Optional[float]) -> str:
    if delta is None:
        return "unknown"
    if rule == ">= 0":
        return "pass" if delta >= 0 else "fail"
    if rule == "< 0":
        return "pass" if delta < 0 else "fail"
    return "pass" if delta <= 0 else "fail"  # "<= 0"


def _existing_overrides_raw(target: Path) -> dict:
    path = overrides_path(target)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _overrides_content(
    target: Path, layer_changes: List[LayerChange], source: str
) -> dict:
    """The exact overrides-file content ``--apply`` will write.

    Merges over the existing file so unrelated pins survive: keys whose
    upper-case form collides with a new pin are replaced (the loader
    uppercases, so ``"CRITIC"`` and ``"critic"`` are the same pin), everything
    else is preserved verbatim. Deterministic — no timestamps — so
    "writes exactly as proposed" stays true however long the human deliberates.
    """
    existing = _existing_overrides_raw(target)
    existing_layers = existing.get("layers")
    if not isinstance(existing_layers, dict):
        existing_layers = {}
    new_keys_upper = {change.name.upper() for change in layer_changes}
    merged_layers = {
        key: value
        for key, value in existing_layers.items()
        if not (isinstance(key, str) and key.upper() in new_keys_upper)
    }
    for change in layer_changes:
        merged_layers[change.name] = change.value
    content: dict = {"layers": merged_layers, "source": source}
    for key, value in existing.items():
        if key not in ("layers", "source"):
            content[key] = value
    return content


def build_proposal(facts: ReportFacts, target: Path) -> Proposal:
    """Pure decision rules: report facts → proposal. No writes, no I/O beyond
    reading the target's existing config/overrides to render exact content."""
    proposal = Proposal(report_name=facts.name, report_path=facts.path)

    # --- Layer stream: the #981 four-gate rule ---------------------------
    nf = facts.new_flow
    if not nf.available:
        reason = nf.sentinel or (
            "the report has no `## New-flow vs full` table (section or rows "
            "missing)"
        )
        proposal.layer_notes.append("No change proposed.")
        proposal.layer_evidence.append(reason)
    else:
        states = {
            label: _gate_state(rule, getattr(nf, attr))
            for label, attr, rule in _GATES
        }
        failing = [label for label, _, _ in _GATES if states[label] == "fail"]
        unknown = [label for label, _, _ in _GATES if states[label] == "unknown"]
        gates_text = (
            "solve-rate delta >= 0, dollars-per-solved delta < 0, "
            "wall-time delta < 0, false-green delta <= 0"
        )
        if not failing and not unknown:
            proposal.layer_notes.append(
                f"All four #981 gates pass ({gates_text}). Pin the new-flow "
                "layers ON — the recorded default-flip decision."
            )
            proposal.layer_changes = [
                LayerChange(name=layer, value=True) for layer in NEW_FLOW_LAYERS
            ]
        elif failing:
            proposal.layer_notes.append(
                f"Gate(s) failed: {', '.join(failing)} (rule: {gates_text}). "
                "Pin the new-flow layers OFF."
            )
            proposal.layer_changes = [
                LayerChange(name=layer, value=False) for layer in NEW_FLOW_LAYERS
            ]
        else:
            proposal.layer_notes.append(
                "No change proposed: gate(s) "
                f"{', '.join(unknown)} are n/a in the report — undefined "
                "evidence decides nothing."
            )
        for label in NEW_FLOW_ROW_LABELS:
            if label in nf.rows:
                proposal.layer_evidence.append(nf.rows[label])
        if proposal.layer_changes:
            proposal.overrides_content = _overrides_content(
                target, proposal.layer_changes, facts.name
            )

    # --- Routing stream: measured overspend → model step-down ------------
    rt = facts.routing
    for raw in (rt.regret_line, rt.net_delta_line):
        if raw:
            proposal.routing_evidence.append(raw)
    overspend = (rt.total_regret_usd is not None and rt.total_regret_usd > 0) or (
        rt.net_delta_usd is not None and rt.net_delta_usd > 0
    )
    if rt.regret_line is None and rt.net_delta_line is None:
        proposal.routing_notes.append(
            "No change proposed: the report carries no routing cost lines "
            "(no per-run records)."
        )
    elif not overspend:
        proposal.routing_notes.append(
            "No change proposed: the report shows no measured routing "
            "overspend."
        )
    else:
        proposal.routing_changes = _routing_changes_from_config(target)
        if not proposal.routing_changes:
            proposal.routing_notes.append(
                "The report shows routing overspend, but this checkout pins "
                "no model with a cheaper tier to step down to. Run "
                "`agentrail cost --routing --apply` for per-run "
                "recommendations."
            )

    return proposal


def _routing_changes_from_config(target: Path) -> List[RoutingChange]:
    """Pinned ``runners.<agent>.models.<phase>`` entries with a cheaper tier."""
    config_path = target / ".agentrail" / "config.json"
    try:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    runners = cfg.get("runners") if isinstance(cfg, dict) else None
    if not isinstance(runners, dict):
        return []
    changes: List[RoutingChange] = []
    for agent in sorted(runners):
        runner_cfg = runners[agent]
        models = runner_cfg.get("models") if isinstance(runner_cfg, dict) else None
        if not isinstance(models, dict):
            continue
        for phase in sorted(models):
            current = models[phase]
            if not isinstance(current, str) or not current:
                continue
            cheaper = cheaper_model(current)
            if cheaper is not None:
                changes.append(
                    RoutingChange(
                        agent=agent,
                        phase=phase,
                        current_model=current,
                        proposed_model=cheaper,
                    )
                )
    return changes


# --- Rendering --------------------------------------------------------------


def render_proposal(proposal: Proposal) -> str:
    """The proposal as printed by the default (read-only) invocation."""
    out: List[str] = []
    out.append(f"Proposal from {proposal.report_name}")
    out.append("Mode: proposal only — nothing is written without --apply.")
    out.append("")

    out.append("Layer overrides (.agentrail/layer-overrides.json):")
    for note in proposal.layer_notes:
        out.append(f"  {note}")
    for change in proposal.layer_changes:
        out.append(f"  Set {change.name} = {json.dumps(change.value)}")
    for evidence in proposal.layer_evidence:
        out.append(f'  Evidence: "{evidence}"')
    if proposal.overrides_content is not None:
        out.append("  --apply writes this file content:")
        for line in json.dumps(proposal.overrides_content, indent=2).splitlines():
            out.append(f"  {line}")
    out.append("")

    out.append("Routing (.agentrail/config.json):")
    for note in proposal.routing_notes:
        out.append(f"  {note}")
    for change in proposal.routing_changes:
        out.append(
            f"  Set runners.{change.agent}.models.{change.phase} = "
            f"{change.proposed_model} (was: {change.current_model})"
        )
    for evidence in proposal.routing_evidence:
        out.append(f'  Evidence: "{evidence}"')
    out.append("")

    if proposal.has_changes:
        out.append(
            "Apply with: agentrail evals apply --report "
            f"{proposal.report_path} --apply"
        )
    else:
        out.append("No changes proposed. Nothing to apply.")
    return "\n".join(out)


# --- Apply ------------------------------------------------------------------


def apply_proposal(
    proposal: Proposal,
    target: Path,
    link_loader: Callable[[Path], Optional[dict]] = load_link,
) -> List[str]:
    """Write the proposal. Auth first, writes second, exactly as proposed.

    Fail-closed (AC3): when the target has no configured server link — no
    ``.agentrail/server.json`` and incomplete ``AGENTRAIL_SERVER_*`` env —
    this raises :class:`ApplyAuthError` BEFORE inspecting the proposal, so an
    unconfigured secret can never fall through to a write. The GitHub
    webhook's ``if (!secret) return true`` fail-open skip is the named
    anti-pattern this refuses to copy.

    Returns the human-readable result lines (``Applied:`` / ``No-op:``).
    """
    if link_loader(target) is None:
        raise ApplyAuthError(
            "apply refused: no server link is configured for this target "
            "(no .agentrail/server.json and AGENTRAIL_SERVER_BASE_URL / "
            "AGENTRAIL_SERVER_API_KEY / AGENTRAIL_SERVER_REPOSITORY_ID are "
            "not all set). The apply path is fail-closed: unconfigured auth "
            "rejects the request, it never skips the check."
        )

    lines: List[str] = []
    if proposal.overrides_content is not None:
        path = overrides_path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(proposal.overrides_content, indent=2) + "\n",
            encoding="utf-8",
        )
        pins = ", ".join(
            f"{change.name}={json.dumps(change.value)}"
            for change in proposal.layer_changes
        )
        lines.append(f"Applied: {path} ({pins})")
    for change in proposal.routing_changes:
        rec = {
            "phase": change.phase,
            "cheaper_model": change.proposed_model,
            "model_used": change.current_model,
        }
        updated = _apply_routing(rec, target, change.agent)
        if updated:
            lines.append(
                f"Applied: runners.{change.agent}.models.{change.phase} = "
                f"{change.proposed_model} (was: {change.current_model})"
            )
        else:
            lines.append(
                f"No-op: runners.{change.agent}.models.{change.phase} "
                f"already at {change.proposed_model} or cheaper."
            )
    if not lines:
        lines.append("Nothing to apply: the proposal contains no changes.")
    return lines
