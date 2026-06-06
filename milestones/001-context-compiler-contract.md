# Milestone 001: Context Compiler Contract

## Source PRD

docs/prd/context-compiler-enterprise-control-plane.md

## Outcome

AgentRail exposes a clear Context Compiler contract that turns a task, issue, PR, error, or review request into auditable retrieval evidence: anchors, candidates, graph expansion, policy decisions, rerank result, token pack, citations, reasons, and metrics.

## Users

- Context-engine maintainer
- Agent provider integrator
- Engineering lead auditing agent context

## Vertical Scope

This milestone may touch:

- Domain logic: Context Compiler contract, anchor extraction, candidate/result models, policy metadata, token budget metadata.
- API/routes: CLI JSON output shape for compiler-facing commands.
- Data/storage: local context pack and index artifacts.
- Tests: contract-level tests for JSON shape, citations, reasons, policy metadata, and budget metadata.
- Docs/config: context-engine docs, PRD links, contract examples.

## Acceptance Criteria

- [ ] A Context Compiler contract is documented with stable fields for anchors, candidates, graph expansion, policy decisions, rerank result, token pack, citations, reasons, and metrics.
- [ ] Existing context query/build JSON remains backward compatible or includes an explicit compatibility path.
- [ ] Every included and excluded compiler result has a citation and reason.
- [ ] Compiler output includes explicit token budget metadata even before advanced packing is implemented.
- [ ] Tests verify the contract shape from the public CLI boundary.

## Test Plan

- Run `bash scripts/test-python`.
- Run `bash scripts/test-context-query`.
- Run `bash scripts/test-context-packs`.
- Run `bash scripts/test-context-evaluation`.
- Add or update CLI/module tests that assert compiler contract fields.

## Likely Issue Slices

- Define Context Compiler JSON contract and compatibility rules.
- Add anchor extraction output to context query/build results.
- Add policy and budget metadata to compiler results.
- Add compiler metrics and reason coverage to evaluation output.
- Document the compiler contract and migration path.

## Blocked By

None.

## Notes

This milestone should not build the full deterministic Code Graph. It should create the contract that later graph, reranking, token packing, and server ingestion work can rely on.
