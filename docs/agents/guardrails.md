# Guardrails

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: `agentrail guardrails docs --write`
     Source of truth: agentrail/guardrails/registry.py (list_guardrails()). -->

AgentRail's guardrails implement the **Objective Gate**, **Review Gate**,
**Red-Green Proof**, and **Independent Verification** definitions of "done"
(see `CONTEXT.md`).  Agents operate under **Execution-Only Autonomy** and can
read this inventory to see which rules govern a run.

Every guardrail below is enumerated from the single registry
(`agentrail.guardrails.list_guardrails()`); the same list backs
`agentrail guardrails list`.

| Guardrail | Posture | Framework-neutral | What it checks |
| --- | --- | --- | --- |
| `approval_gate` | blocking | yes | Requires human approval before an irreversible action (merge, deploy, protected push) when the approval policy is enabled; disabled by default. |
| `check_runner` | blocking | yes | Runs the declared objective verification command(s) and requires every check to pass; a run with no declared verification is red ('no objective verification declared'). |
| `input_contract` | blocking | yes | Admits an issue to the Issue Queue only when it passes the entrance checks: no prompt-injection directive, and an Acceptance-criteria section with machine-checkable (checkbox) criteria. |
| `objective_gate` | blocking | yes | The single objective definition of done/merge: objective checks (tests/build/lint) + acceptance-criteria coverage + Red-Green and Independent-Verification seams (sync harness), and CI checks (with a pending hold) + committed-secret scan + deleted-file-still-referenced (async harness). No LLM opinion participates. |
| `output_enforcer` | blocking | yes | Rejects full-file rewrites of existing files; accepts diff/patch edits and any content for new files or renames. |
| `proof_required` | blocking | yes | Flags changes that touch declared source globs (and so require a test/proof) versus changes that are legitimately test-free; config-driven and framework-neutral. |
| `push_guardrail` | blocking | yes | Blocks a commit/push that contains a detected secret or targets a protected/production branch; records every block as an Audit Event. |
| `red_green` | blocking | yes | Requires a Red-Green Proof: an acceptance test must be observed failing (red) before implementation and passing (green) after — proving the test is real, not tautological. |
| `sandbox_enforcement` | blocking | yes | Enforces in-sandbox Context Compiler use: a run that bypassed the context-enforcement hook (any recorded bypass attempt) fails. |
