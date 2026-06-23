"""Issue #921: the six migrated guardrails are registered + their shims transparent.

Covers:
* AC1 — ``list_guardrails()`` enumerates all six migrated guardrails (plus
  ``output_enforcer`` from #918 and ``proof_required`` from #919) with
  name + blocking-vs-advisory metadata.
* AC2/AC4 — the pure decision logic now lives in the package; the old module
  paths are transparent re-export shims (same objects, not copies).
* The migrated guardrails' ``evaluate`` maps their legacy decision to a Verdict.
"""
from __future__ import annotations

from agentrail.guardrails import (
    Guardrail,
    Verdict,
    VerdictStatus,
    get_guardrail,
    list_guardrails,
)

# The full shipped set after #921: #918 + #919 + the six migrated here.
_MIGRATED = {
    "push_guardrail",
    "input_contract",
    "red_green",
    "approval_gate",
    "sandbox_enforcement",
    "check_runner",
}
_EXPECTED = _MIGRATED | {"output_enforcer", "proof_required"}


# ---------------------------------------------------------------------------
# AC1: registry includes all six migrated entries (+ #918/#919) with metadata
# ---------------------------------------------------------------------------

class TestRegistryAC1:
    def test_all_expected_guardrails_registered(self):
        names = {g.name for g in list_guardrails()}
        assert _EXPECTED <= names, f"missing: {sorted(_EXPECTED - names)}"

    def test_each_migrated_exposes_metadata(self):
        for name in _MIGRATED:
            g = get_guardrail(name)
            assert g.name == name
            assert isinstance(g.description, str) and g.description.strip()
            assert isinstance(g.blocking, bool)
            # Every migrated guardrail is a blocking policy.
            assert g.blocking is True

    def test_every_entry_satisfies_protocol(self):
        for g in list_guardrails():
            assert isinstance(g, Guardrail)
            assert g.name and g.description
            assert isinstance(g.blocking, bool)
            assert callable(g.evaluate)

    def test_list_is_sorted_and_deterministic(self):
        names = [g.name for g in list_guardrails()]
        assert names == sorted(names)
        assert names == [g.name for g in list_guardrails()]


# ---------------------------------------------------------------------------
# AC2/AC4: the old module paths are transparent re-export shims
# ---------------------------------------------------------------------------

class TestShimsAreTransparent:
    def test_red_green_shim_reexports_same_objects(self):
        from agentrail.run.red_green import Observation, Trail, gate_evidence, verify_trail
        from agentrail.guardrails.policies.red_green import (
            Observation as PObservation,
            Trail as PTrail,
            gate_evidence as p_gate_evidence,
            verify_trail as p_verify_trail,
        )
        assert Observation is PObservation
        assert Trail is PTrail
        assert verify_trail is p_verify_trail
        assert gate_evidence is p_gate_evidence

    def test_push_guardrail_shim_reexports_pure_objects(self):
        from agentrail.run.push_guardrail import (
            PushDecision,
            SecretFinding,
            detect_secrets,
            evaluate_push,
            guard_push,
        )
        from agentrail.guardrails.policies.push_guardrail import (
            PushDecision as PPushDecision,
            SecretFinding as PSecretFinding,
            detect_secrets as p_detect_secrets,
            evaluate_push as p_evaluate_push,
            guard_push as p_guard_push,
        )
        assert PushDecision is PPushDecision
        assert SecretFinding is PSecretFinding
        assert detect_secrets is p_detect_secrets
        assert evaluate_push is p_evaluate_push
        assert guard_push is p_guard_push

    def test_input_contract_shim_reexports_same_objects(self):
        from agentrail.afk.input_contract import Rejected, Validated, admit_to_queue, validate
        from agentrail.guardrails.policies.input_contract import (
            Rejected as PRejected,
            Validated as PValidated,
            admit_to_queue as p_admit_to_queue,
            validate as p_validate,
        )
        assert Rejected is PRejected
        assert Validated is PValidated
        assert validate is p_validate
        assert admit_to_queue is p_admit_to_queue

    def test_approval_gate_shim_reexports_same_objects(self):
        from agentrail.run.approval_gate import (
            ApprovalPolicy,
            IrreversibleAction,
            evaluate_action,
        )
        from agentrail.guardrails.policies.approval_gate import (
            ApprovalPolicy as PApprovalPolicy,
            IrreversibleAction as PIrreversibleAction,
            evaluate_action as p_evaluate_action,
        )
        assert ApprovalPolicy is PApprovalPolicy
        assert IrreversibleAction is PIrreversibleAction
        assert evaluate_action is p_evaluate_action

    def test_check_runner_shim_reexports_pure_and_io(self):
        from agentrail.run.check_runner import (
            VerifyCheck,
            parse_verify_config,
            run_objective_checks,
        )
        from agentrail.guardrails.policies.check_runner import (
            VerifyCheck as PVerifyCheck,
            parse_verify_config as p_parse_verify_config,
        )
        from agentrail.guardrails.adapters.check_runner import (
            run_objective_checks as a_run_objective_checks,
        )
        # Pure mapping re-exported from the policy.
        assert VerifyCheck is PVerifyCheck
        assert parse_verify_config is p_parse_verify_config
        # I/O re-exported from the adapter.
        assert run_objective_checks is a_run_objective_checks

    def test_sandbox_enforcement_shim_reexports_pure_and_io(self):
        from agentrail.run.sandbox_enforcement import (
            compute_token_delta,
            install_sandbox_hooks,
        )
        from agentrail.guardrails.policies.sandbox_enforcement import (
            compute_token_delta as p_compute_token_delta,
        )
        from agentrail.guardrails.adapters.sandbox_enforcement import (
            install_sandbox_hooks as a_install_sandbox_hooks,
        )
        assert compute_token_delta is p_compute_token_delta
        assert install_sandbox_hooks is a_install_sandbox_hooks


# ---------------------------------------------------------------------------
# Each migrated guardrail's evaluate() maps its legacy decision to a Verdict
# ---------------------------------------------------------------------------

class TestMigratedEvaluateMapsDecision:
    def test_red_green_pass_and_fail(self):
        from agentrail.guardrails.policies.red_green import Observation

        g = get_guardrail("red_green")
        ok = g.evaluate(observations=[Observation("t", False), Observation("t", True)])
        assert ok.status is VerdictStatus.PASS
        bad = g.evaluate(observations=[Observation("t", True)])  # never red
        assert bad.status is VerdictStatus.FAIL and bad.reasons

    def test_push_guardrail_secret_blocks(self):
        g = get_guardrail("push_guardrail")
        v = g.evaluate(targets=["feature"], content="AKIAABCDEFGHIJKLMNOP")
        assert v.status is VerdictStatus.FAIL
        clean = g.evaluate(targets=["feature"], content="just code")
        assert clean.status is VerdictStatus.PASS

    def test_push_guardrail_protected_target_blocks(self):
        g = get_guardrail("push_guardrail")
        v = g.evaluate(targets=["origin/main"], content="ordinary diff")
        assert v.status is VerdictStatus.FAIL

    def test_input_contract_checkbox_pass_prose_fail(self):
        g = get_guardrail("input_contract")
        body = "## Acceptance criteria\n- [ ] AC1: something runnable\n"
        assert g.evaluate(issue_body=body).status is VerdictStatus.PASS
        prose = "## Acceptance criteria\nit should feel fast\n"
        assert g.evaluate(issue_body=prose).status is VerdictStatus.FAIL

    def test_approval_gate_default_disabled_passes(self):
        from agentrail.guardrails.policies.approval_gate import (
            ApprovalPolicy,
            IrreversibleAction,
        )

        g = get_guardrail("approval_gate")
        v = g.evaluate(
            policy=ApprovalPolicy(),  # disabled by default
            action=IrreversibleAction(kind="merge", target="PR #1"),
        )
        assert v.status is VerdictStatus.PASS

    def test_approval_gate_enabled_requires_approval(self):
        from agentrail.guardrails.policies.approval_gate import (
            Approval,
            ApprovalPolicy,
            IrreversibleAction,
        )

        g = get_guardrail("approval_gate")
        action = IrreversibleAction(kind="merge", target="PR #1")
        blocked = g.evaluate(policy=ApprovalPolicy(enabled=True), action=action)
        assert blocked.status is VerdictStatus.FAIL
        approved = g.evaluate(
            policy=ApprovalPolicy(enabled=True),
            action=action,
            approval=Approval(approved=True, by="alice"),
        )
        assert approved.status is VerdictStatus.PASS

    def test_check_runner_results_decision(self):
        from agentrail.run.objective_gate import CheckResult

        g = get_guardrail("check_runner")
        assert g.evaluate(results=[]).status is VerdictStatus.FAIL  # none declared
        ok = g.evaluate(results=[CheckResult(name="t", passed=True, detail="exit 0")])
        assert ok.status is VerdictStatus.PASS
        bad = g.evaluate(results=[CheckResult(name="t", passed=False, detail="exit 1")])
        assert bad.status is VerdictStatus.FAIL

    def test_sandbox_enforcement_bypass_count_decision(self):
        g = get_guardrail("sandbox_enforcement")
        assert g.evaluate(bypass_count=0).status is VerdictStatus.PASS
        assert g.evaluate(bypass_count=3).status is VerdictStatus.FAIL


# ---------------------------------------------------------------------------
# AC4: the old run/ + afk/ modules hold no decision logic (only re-exports)
# ---------------------------------------------------------------------------

class TestNoDecisionLogicInShimsAC4:
    SHIMS = [
        "agentrail.run.red_green",
        "agentrail.run.push_guardrail",
        "agentrail.run.approval_gate",
        "agentrail.run.check_runner",
        "agentrail.run.sandbox_enforcement",
        "agentrail.afk.input_contract",
    ]

    def test_shims_only_reexport_or_io(self):
        """A shim defines no guardrail decision function: every public callable it
        owns is either re-exported from the package (``__module__`` points at the
        guardrails package) or is an I/O edge that legitimately stays behind the
        shim (push's ``make_server_emitter``)."""
        import importlib
        import inspect

        io_edges = {("agentrail.run.push_guardrail", "make_server_emitter")}
        for mod_name in self.SHIMS:
            mod = importlib.import_module(mod_name)
            for attr in getattr(mod, "__all__", []):
                obj = getattr(mod, attr)
                if not (inspect.isfunction(obj) or inspect.isclass(obj)):
                    continue
                origin = getattr(obj, "__module__", "")
                if (mod_name, attr) in io_edges:
                    # Allowed I/O edge: defined locally in the shim on purpose.
                    assert origin == mod_name
                    continue
                assert origin.startswith("agentrail.guardrails"), (
                    f"{mod_name}.{attr} should be re-exported from the guardrails "
                    f"package, but is defined in {origin!r} (decision logic left "
                    f"in the shim?)"
                )
