# AgentRail MCP

Agent-neutral stdio MCP tools for project context and development workflow. No Jace service or key is required.

## Tools
- `context_search`, `context_get`, `context_build_pack`, `context_explain_pack`: bounded context through the Python CLI.
- `context_def`, `context_callers`, `context_callees`, `context_impact`: code graph navigation.
- `workflow_repositories`, `workflow_list`, `workflow_start`, `workflow_get`, `workflow_update`: workspace-scoped durable tasks shared with the Console.
- `workflow_check`: execute a configured local check once, bound to the connected task repository/branch, and report its exit code, commit SHA, dirty flag and output digest.

## Build and configure

```sh
pnpm --filter @agentrail/mcp build
```

Use any MCP-compatible client's configuration format with these values:
- command: `node`
- arguments: `/absolute/path/to/agentrail/packages/mcp/dist/index.js`
- `AGENTRAIL_BIN`: the absolute AgentRail CLI path
- `AGENTRAIL_TARGET`: the project checkout
- `AGENTRAIL_WORKFLOW_BASE_URL`: your Console origin (HTTPS remotely; loopback HTTP locally)
- `AGENTRAIL_WORKFLOW_API_KEY`: a workspace `workflow_mcp` key created in Console → Agents

Index the target first: `agentrail context index --target /path/to/project`.

Tasks are credential/workspace-scoped. Agent labels are unverified client-provided labels. Event keys deduplicate retries; revisions reject stale writes. A configured check reserves execution under its credential, blocks concurrent progress/closure, and has bounded process-group execution. An expired ambiguous reservation needs an explicit owner/admin release. Reports and check receipts do not become independent verification, and only a human can close/reopen through the Console. Raw check logs are not uploaded. Costs are not recorded by these tools.

Jace conversation, Acceptance Record and correction tools moved to [Bensigo/jace](https://github.com/Bensigo/jace).

## Local integration proof
After building the Console and applying migrations to a dedicated local database ending `_proof`, set `DATABASE_URL` and run:

```sh
node packages/mcp/scripts/proof-with-console.mjs
```

The script starts the production Console and exercises actual MCP clients, PostgreSQL persistence, scoped credentials, retries, configured checks and human decisions. It does not exercise real third-party coding-agent applications or production services.
