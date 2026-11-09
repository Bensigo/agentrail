# AgentRail

Open-source development workflow, project context and Console for any MCP-compatible coding agent. Jace is an independent optional trust layer, not a signup prerequisite.

## Current source setup

Use the repository's [local setup](https://github.com/Bensigo/agentrail/blob/main/LOCAL.md):

```sh
pnpm install --frozen-lockfile
pnpm local:up
```

The local command prepares a Python virtual environment and MCP server, builds the Console, starts isolated databases/storage, applies migrations and opens your local operator session. In Console → Agents, create a workspace workflow key and connect your agent using the displayed MCP command and environment. No hosted product account is needed.

## Optional native runner

Connect to your own AgentRail Console:

```sh
agentrail login --url http://localhost:3000
agentrail runner
```

This is the native queue/issue execution path. MCP-connected agents can work directly with `workflow_start`, bounded context, `workflow_update` and configured `workflow_check` calls. Reports, actual check receipts and human decisions stay distinct.

Published npm releases may lag the repository. Use the source checkout for the separated local-first product until a new version is released. See the repository README for installation, context indexing and verification details.

Apache-2.0.
