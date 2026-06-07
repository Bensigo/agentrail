# Failure Patterns

Recurring ways agents, automation, tests, deployments, or product workflows fail in this project.

Keep entries concrete: what failed, how to detect it, and what future agents should do differently.

## High-volume tests that claim to cover all event kinds should list all kinds or explicitly document the subset

- kind: failure-pattern
- source: PR #152 review: high-volume test covers 4 of 6 event kinds without documenting the omission in the test name or comment
- confidence: verified
- created_at: 2026-06-07
- expires_at:

When writing high-volume ingestion tests that are mapped to an acceptance criterion about 'all event kinds', either include all kinds in the loop or add a comment explaining the intentional subset. This prevents future reviewers from flagging incomplete coverage.
