# Backend API

Use this skill when implementing or changing API routes, service logic, persistence, validation, authentication, authorization, or integration boundaries.

## Workflow

1. Identify the contract first: request shape, response shape, status codes, side effects, and error cases.
2. Validate inputs at the boundary closest to the API.
3. Keep persistence and external integration behavior observable and testable.
4. Preserve existing auth, authorization, tenancy, and rate-limit assumptions.
5. Add focused tests for changed contracts and failure paths.

## Verification

- Run targeted unit or integration tests for the changed API behavior.
- Run broader checks when shared middleware, data access, auth, or schema contracts are touched.
