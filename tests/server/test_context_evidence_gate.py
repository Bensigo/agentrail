"""Unit tests for the context-evidence review gate evaluator."""

import pytest
from agentrail.server.gates import evaluate_context_evidence, GATE_NAME


COMPLETE_EVIDENCE = {
    "contextPackFile": ".agentrail/context/packs/issue-331.json",
    "selectedSources": ["CONTEXT.md", "packages/db-postgres/src/schema/runs.ts"],
    "retrievalBudget": {"maxTokens": 8000, "used": 4200},
    "citations": [{"label": "CONTEXT.md:83", "url": "CONTEXT.md#L83"}],
}


# ---------------------------------------------------------------------------
# AC1 — complete evidence passes
# ---------------------------------------------------------------------------

def test_complete_evidence_passes():
    result = evaluate_context_evidence(COMPLETE_EVIDENCE)
    assert result.status == "passed"
    assert result.passed is True
    assert result.blocking_reasons == []
    assert result.gate_name == GATE_NAME


def test_complete_evidence_passes_with_enforce():
    result = evaluate_context_evidence(COMPLETE_EVIDENCE, enforce=True)
    assert result.status == "passed"
    assert result.passed is True


# ---------------------------------------------------------------------------
# AC2 — missing fields trigger gate (warn by default)
# ---------------------------------------------------------------------------

def test_missing_context_pack_file_fails():
    evidence = {**COMPLETE_EVIDENCE, "contextPackFile": None}
    result = evaluate_context_evidence(evidence)
    assert result.status == "failed"
    assert "missing contextPackFile" in result.blocking_reasons


def test_missing_selected_sources_fails():
    evidence = {**COMPLETE_EVIDENCE, "selectedSources": []}
    result = evaluate_context_evidence(evidence)
    assert result.status == "failed"
    assert "missing selectedSources" in result.blocking_reasons


def test_missing_retrieval_budget_fails():
    evidence = {**COMPLETE_EVIDENCE, "retrievalBudget": None}
    result = evaluate_context_evidence(evidence)
    assert result.status == "failed"
    assert "missing retrievalBudget" in result.blocking_reasons


def test_missing_citations_fails():
    evidence = {**COMPLETE_EVIDENCE, "citations": []}
    result = evaluate_context_evidence(evidence)
    assert result.status == "failed"
    assert "missing citations" in result.blocking_reasons


def test_all_fields_missing_fails_with_four_reasons():
    result = evaluate_context_evidence({})
    assert result.status == "failed"
    assert len(result.blocking_reasons) == 4
    assert "missing contextPackFile" in result.blocking_reasons
    assert "missing selectedSources" in result.blocking_reasons
    assert "missing retrievalBudget" in result.blocking_reasons
    assert "missing citations" in result.blocking_reasons


def test_partial_presence_reports_missing_fields_only():
    evidence = {
        "contextPackFile": "pack.json",
        "selectedSources": ["file.ts"],
        # retrievalBudget and citations absent
    }
    result = evaluate_context_evidence(evidence)
    assert result.status == "failed"
    assert len(result.blocking_reasons) == 2
    assert "missing retrievalBudget" in result.blocking_reasons
    assert "missing citations" in result.blocking_reasons


# ---------------------------------------------------------------------------
# AC4 — warn-vs-fail configurable via enforce flag
# ---------------------------------------------------------------------------

def test_enforce_false_is_warn_mode():
    evidence = {**COMPLETE_EVIDENCE, "contextPackFile": None}
    result = evaluate_context_evidence(evidence, enforce=False)
    assert result.status == "failed"
    # enforce=False means caller does not block — condition recorded
    assert result.conditions[0]["enforce"] is False


def test_enforce_true_is_fail_mode():
    evidence = {**COMPLETE_EVIDENCE, "contextPackFile": None}
    result = evaluate_context_evidence(evidence, enforce=True)
    assert result.status == "failed"
    assert result.conditions[0]["enforce"] is True


def test_conditions_always_include_gate_name():
    result = evaluate_context_evidence(COMPLETE_EVIDENCE)
    assert result.conditions[0]["gateName"] == GATE_NAME
