# AgentRail operating contract

AgentRail is the standalone development workflow and Console for any MCP-compatible coding agent. Read CONTEXT.md and docs/repository-separation.md before non-trivial work. The owner's 2026-11-09 separation decision supersedes historical Jace product framing in this repository.

Jace's trust layer is maintained independently at https://github.com/Bensigo/jace. Do not reintroduce its conversation, Acceptance Records, Contracts, criterion-evidence or correction tools as requirements for AgentRail. Historical database migrations and compatibility helpers are intentionally retained; do not delete data to simplify the split.

Keep CLI/MCP behavior agent-neutral. MCP and Console must use the same durable workflow records. Agent reports, local check receipts, independent verification and human decisions are distinct. A model's success claim is not verification. Never give an agent authority to impersonate a human decision.

Preserve unrelated edits. Verify source, local runtime, CI, deployed/live and customer behavior separately. Do not claim merges, deployments, external-agent-client acceptance or production migration without observing them. Changes to workflow persistence, tenancy or execution need meaningful regression coverage.
