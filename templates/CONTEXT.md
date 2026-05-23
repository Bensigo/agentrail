# CONTEXT.md

## Project Purpose

Describe what this project does, who it serves, and the business outcome it exists to create.

Keep this file factual. Agents use it to make implementation decisions without inventing product strategy.

## Users

Primary users:

- Founder or small team operator.
- Internal teammate responsible for delivery, sales, operations, or support.
- Customer or end user, if the product has an external surface.

## Product Principles

- Ship useful vertical slices before broad platforms.
- Prefer simple workflows that can be operated by a small team.
- Make state visible: work should be easy to inspect, resume, and review.
- Automate repeated work only after the manual workflow is understood.
- Do not hide important business logic in prompts without documenting it.

## Technical Principles

- Prefer boring, well-supported tools.
- Keep integrations explicit and observable.
- Avoid abstractions that are not paying for themselves.
- Tests should cover business-critical paths and failure-prone integration edges.
- UI should support the real workflow, not perform as a landing page unless that is the product.

## Architecture Notes

Add the current architecture here:

- App framework:
- Runtime:
- Database:
- Auth:
- Background jobs:
- External APIs:
- Hosting:
- Observability:

## Agent Operating Context

Agents should:

- Read this file before non-trivial implementation.
- Run `scripts/memory recall "<task>"` before non-trivial planning, implementation, or review.
- Prefer existing docs and code over assumptions.
- Use GitHub issues for task state.
- Use PRs for review state.
- Record verification clearly.

Agents should not:

- Invent requirements when the issue is underspecified.
- Treat project memory as more authoritative than current code, `CONTEXT.md`, ADRs, issues, or PRs.
- Perform large refactors without an issue.
- Change product behavior without documenting the decision.

## Open Questions

Track important unknowns here until they are resolved:

- 
