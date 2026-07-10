---
name: backend-api
description: API routes, service logic, persistence, validation, auth, and server-side behavior. Use when the task mentions API endpoints, backend, database, migrations, auth, permissions, validation, contracts, webhooks, queues, or external service integration.
---

# Backend API

Use this skill for API routes, service logic, persistence, validation, authentication, authorization, integrations, or server-side behavior that clients depend on.

## Activation Guidance

Activate when the task mentions API, backend, endpoints, server routes, database, migrations, auth, permissions, validation, contracts, webhooks, queues, or external service integration.

## Context To Inspect

- Existing API contract: request shape, response shape, status codes, headers, side effects, and error cases.
- Route handlers, service layer, middleware, auth/authorization assumptions, tenancy, rate limits, and validation boundaries.
- Persistence model, migrations, schema files, transaction behavior, indexes, and seed/fixture data.
- Existing client usage, generated types, OpenAPI/schema files, and integration tests that depend on the contract.

## Constraints

- Do not change API contracts silently; update tests and generated/docs artifacts when contracts change.
- Validate inputs at the API boundary closest to the request.
- Preserve auth, authorization, tenancy, and rate-limit semantics unless the issue explicitly changes them.
- Treat migrations and persistence changes as user-data risk; keep rollback or compatibility in view.
- Make error behavior explicit instead of leaking raw internal failures.

## Verification Requirements

- Run focused unit or integration tests for changed API behavior.
- Cover success and error behavior, including auth/permission outcomes when relevant.
- Run migration/schema validation or database tests when persistence changes.
- Run broader tests when shared middleware, client contract generation, auth, or schema contracts are touched.

## Expected PR Evidence

- API contract inspected and any contract change described.
- Persistence/migration impact and auth/permission impact noted.
- Verification commands for success, error, and data behavior.
- Client/docs/generated artifact updates when applicable.

## Provenance / Audit

- Local status: AgentRail-authored first-party skill.
- Upstream sources reviewed: Mindrally skills repository at `https://github.com/Mindrally/skills`, candidate path `backend-development/SKILL.md` observed.
- License status: repository reported Apache-2.0; candidate used for audit awareness only.
- Local changes: focused on contract drift prevention, persistence/migration checks, auth/permission checks, explicit error behavior, and test verification.
- Audit notes: no third-party skill text vendored; source is a provenance candidate, not an install source.
