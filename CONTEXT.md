# AgentRail

AgentRail is a repo-native development workflow and Console for any coding agent that supports MCP. It supplies project context, task progress, local check execution, resumable state and review visibility. The user chooses and operates the coding agent.

## Components
- `agentrail/`: Python CLI, context compiler/index, curated skills, issue workflow, native runner and internal execution/evaluation machinery.
- `packages/mcp`: stdio MCP repository-context tools and agent-led workflow tools. No Jace credentials or service required.
- `apps/console`: AgentRail's authenticated workflow Console and backend. `Work` shows MCP tasks; `Native runner` retains the existing queue workflow, and `Runs`/`Review gates`/diagnostics retain native-run evidence.
- `packages/*`: repository-local auth, database, contracts, GitHub and UI infrastructure.

## Authority
MCP keys are workspace-scoped `workflow_mcp` credentials, distinct from native-runner and Jace keys. The server derives tenant and actor identity. Reports are labelled agent-reported. Agents may request human review but cannot close/reopen a task. A same-origin owner/admin Console action records the decision. A configured local check is bound to the task repository and branch, reserves execution once, and retains a commit SHA, dirty flag, exit code and output digest. It does not upload logs or become Jace acceptance proof. Costs are unknown unless actually metered. A dedicated `workflow_release` credential is required for the release check reservation and receipt. The check binds the reviewed PR head, merge commit, and prepared deployment URL.

## Jace
The independent trust product lives at https://github.com/Bensigo/jace. It owns Acceptance Contracts, exact-head criterion evidence, corrections and acceptance decisions. Integration with AgentRail is optional and must use explicit APIs, never the other product's database or filesystem.

Historical ADR 0012 and the trust migration ledger remain migration history, not AgentRail's current product authority. Full pre-split source and Git history are retained in Jace. Inherited SQL history and database compatibility helpers are deliberately retained here so existing records are not destroyed. Each repository now owns future migrations and uses separate databases, credentials and release configuration. Production cutover is a separate operational step.

See docs/repository-separation.md for the approved scope and evidence boundaries.
