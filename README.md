# AgentRail — workflow and Console for coding agents

Connect any MCP-compatible coding agent to project context, development tasks, configured checks and an inspectable Console. You keep using your agent; AgentRail records the workflow. No Jace account, coordinator or trust service is required.

[Jace](https://github.com/Bensigo/jace) is now an independent repository for Acceptance Contracts, exact-head criterion evidence, corrections and human acceptance decisions.

## Fully local, open-source setup

See [LOCAL.md](LOCAL.md). With Node 24, pnpm 9, Python 3.11+ and Docker Compose:

```sh
pnpm install --frozen-lockfile
pnpm local:up
```

Each product has its own Console, database and artifact storage. Local operator sign-in does not require GitHub OAuth or a hosted product account. `pnpm local:open` signs you in again; `pnpm local:down` stops services while preserving data. Vercel is a future deployment target, not a local requirement.

## Development

Use `pnpm local:up` for the complete local stack and `pnpm local:status` for its state. The launcher installs the CLI in `.venv`, builds the MCP server and opens a local owner session. Source changes reload in the Console. See [LOCAL.md](LOCAL.md) for configuration, logs and optional GitHub integration.

In **Agents**, add your repository and create a workflow key. Copy the displayed command, arguments and environment into your coding agent’s MCP settings, replacing the absolute paths for your machine. Clients using TOML or another settings format use the same values. Registering a local repository does not require GitHub OAuth; remote GitHub actions need an optional App installation.

## Daily workflow

1. Ask the agent to use `workflow_repositories`, then `workflow_start` with a stable task key, its own agent label, connected repository and branch.
2. Retrieve bounded project context through `context_search`, `context_get` and `context_build_pack`. Index the project first with `agentrail context index --target /path/to/project`.
3. Use `workflow_update` to report implementation/review progress or a blocker. Use `workflow_get` before resuming and after a revision conflict.
4. Run `workflow_check` for a named project check. Define checks as argv arrays in your project's `.agentrail/config.json`:

```json
{"workflow":{"checks":{"test":["npm","test"],"build":["npm","run","build"]}}}
```

The tool verifies the checkout repository/branch, reserves once, bounds execution to two minutes and 256 KiB output, and reports exit code, commit and output digest. Logs stay local. A crashed/ambiguous reservation is held; an owner may release an expired hold in the Console. Do not re-run a potentially completed check automatically.

5. Report `needs_review` with the PR link. Inspect the history in **Work** and close/reopen the task yourself. Agent reports are not independently verified acceptance evidence. MCP costs are currently not recorded.

## MCP configuration

```json
{"mcpServers":{"agentrail":{"command":"node","args":["/absolute/path/to/agentrail/packages/mcp/dist/index.js"],"env":{"AGENTRAIL_BIN":"/absolute/path/to/agentrail/.venv/bin/agentrail","AGENTRAIL_TARGET":"/absolute/path/to/project","AGENTRAIL_WORKFLOW_BASE_URL":"http://127.0.0.1:3000","AGENTRAIL_WORKFLOW_API_KEY":"<workflow-key>"}}}}
```

Use HTTPS for a remote Console. A key can read/report workflow only in its workspace; it cannot claim native-runner work, mint keys, or make human decisions. Revoke it through the Console API-key endpoint. Do not put secrets in task text or commit MCP settings containing keys.

## Optional native workflow

The existing CLI remains available: `agentrail init`, `doctor`, `upgrade`, `context`, `run issue`, `status`, `resume`, and the optional runner/AFK paths. Supported named engines and custom commands remain native-runner adapters; MCP integration has no agent-name restriction. `agentrail login --url <your-agentrail-console>` connects the optional native worker. Start it with `agentrail runner`. Use the **Native runner**, **Runs** and **Review gates** pages for this history.

## Repository separation

See [the separation record](docs/repository-separation.md) and [moved-source inventory](docs/moved-to-jace.txt). Git history and inherited migrations are preserved. Database compatibility helpers do not imply a running Jace integration. Each product needs its own database, GitHub credentials, deployment project and release lifecycle. This source change does not move production services or old PRs automatically.

Licensed Apache-2.0.
