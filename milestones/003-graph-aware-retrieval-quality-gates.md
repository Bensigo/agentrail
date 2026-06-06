# Milestone 003: Graph-Aware Retrieval Quality Gates

## Source PRD

docs/prd/context-compiler-enterprise-control-plane.md

## Outcome

AgentRail proves that graph-aware retrieval improves context quality without becoming noisy by passing retrieval quality gates on relationship-heavy fixtures.

## Users

- Context-engine maintainer
- Engineering lead evaluating retrieval quality
- Reviewer auditing context inclusion and exclusion

## Vertical Scope

This milestone may touch:

- Domain logic: graph expansion from strong anchors, hop limits, authority/freshness/security policy, reranking inputs, token budget behavior.
- Data/storage: evaluation fixtures and reports.
- Tests: required-source inclusion, citation coverage, stale/denied leakage, bounded graph expansion, precision at budget.
- Docs/config: retrieval quality gate definitions and fixture authoring guidance.

## Acceptance Criteria

- [ ] Required-source inclusion is 100% for approved fixtures.
- [ ] Citation coverage is 100% for included top results and context-pack sections.
- [ ] Stale or denied source leakage is 0 for approved fixtures.
- [ ] Graph expansion starts from strong anchors and respects default hop limits.
- [ ] Token budget behavior is explicit and tested.
- [ ] Evaluation output reports failures clearly enough to guide retrieval fixes.

## Test Plan

- Run `bash scripts/test-context-evaluation`.
- Run `bash scripts/test-context-query`.
- Add relationship-heavy fixtures where basic vector retrieval would miss relevant files.
- Add stale/denied leakage fixtures and bounded-hop fixtures.

## Likely Issue Slices

- Add graph expansion to retrieval from strong anchors.
- Add hop-limit and authority/freshness/security policy scoring.
- Extend evaluation fixtures for relationship-heavy code tasks.
- Add token budget and precision-at-budget reporting.
- Add failure diagnostics for missed required sources and noisy graph expansion.

## Blocked By

Milestone 002: Local Code Graph Index.

## Notes

The goal is not maximum recall at any cost. The goal is the smallest cited context pack that covers the task without stale, irrelevant, or policy-denied sources.
