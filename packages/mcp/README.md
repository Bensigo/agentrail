# @agentrail/mcp

MCP server that exposes AgentRail's compact context retrieval as native tools, so
coding agents (Claude, Cursor, Codex, …) prefer it over raw file search/read —
the MCP/tool-enforcement level from
`docs/benchmarks/context-retrieval-cli-benchmark.md`.

## Tools

| Tool | Maps to | Returns |
| --- | --- | --- |
| `acceptance_correction_packets_get` | authenticated AgentRail server read | the complete immutable packet set for one Record's server-derived current exact head |
| `jace_turn` | authenticated direct Jace turn | one idempotent planning, brainstorming, intake, or control message in the credential-bound task conversation |
| `jace_task_get` | authenticated direct Jace read | the exact `messageKey` reply plus the task-linked Intake, Record, Contract, exact-head Context Pack, and status |
| `context_search` | `agentrail context search` | ranked path + line range + symbol + bounded snippet + reason + score |
| `context_get` | `agentrail context get` | only the requested line range / symbol block — never the whole file |
| `context_build_pack` | `agentrail context build` | a bounded context pack for an issue/PR phase |
| `context_explain_pack` | `agentrail context explain` | why sources were included / excluded / boosted / demoted |

The context tools shell out to the existing `agentrail context …` CLI, so
context retrieval behaviour has a single source of truth. The correction tool
is a separate read-only server call; it cannot acknowledge, dispatch, resume,
approve, or claim a repair.

The Jace tools extend this server; they do not replace repository-context
tools. They derive the workspace from the configured credential and derive the
Acceptance Record from its task Intake. Neither tool accepts a workspace or
Record locator. MCP task text cannot confirm a Contract, and these tools expose
no builder dispatch, implementation, merge, deploy, shell, or filesystem action.

## Build

```bash
pnpm --filter @agentrail/mcp build   # emits dist/index.js
```

## Configuration

The server resolves:

- the AgentRail CLI from `AGENTRAIL_BIN` (default `agentrail` on `PATH`),
- the repo to operate on from the per-call `target` argument, else
  `AGENTRAIL_TARGET`, else the server's working directory.

`acceptance_correction_packets_get` instead uses fixed process configuration:

- `AGENTRAIL_SERVER_BASE_URL` — the AgentRail Console base URL;
- `AGENTRAIL_MCP_CORRECTION_API_KEY` — a workspace-scoped AgentRail API key
  dedicated to this MCP correction read.
- `AGENTRAIL_MCP_JACE_API_KEY` — a dedicated workspace-level `agent_mcp` API
  key used only for direct Jace turns and bounded task-state reads. Generic
  self-hosted runner and fleet keys are rejected; `agent_mcp` keys are denied
  by default from legacy bearer routes.

The tool accepts only a Change Record id. The key supplies workspace authority;
the server derives and revalidates the Record's current PR head, head cycle,
review job, confirmed Acceptance Contract, and complete packet custody. Never
place the API key in an MCP tool argument or prompt.

The target repo must already be indexed (`agentrail context index`).

### Claude Code / Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "agentrail-context": {
      "command": "node",
      "args": ["/abs/path/to/agentrail/packages/mcp/dist/index.js"],
      "env": {
        "AGENTRAIL_BIN": "/abs/path/to/agentrail/scripts/agentrail",
        "AGENTRAIL_TARGET": "/abs/path/to/your/repo",
        "AGENTRAIL_SERVER_BASE_URL": "https://console.example.com",
        "AGENTRAIL_MCP_CORRECTION_API_KEY": "<workspace-api-key>",
        "AGENTRAIL_MCP_JACE_API_KEY": "<agent-mcp-workspace-api-key>"
      }
    }
  }
}
```

## Why route agents through this

Pair it with the AGENTS.md guidance (soft enforcement) so agents are both *told*
to use retrieval first and *given* the native tools to do it: search for
candidates, then `context_get` only the line ranges you need, instead of reading
whole files and burning context.

## CLI vs MCP — token cost

The MCP is for **convenience and enforcement** (agents that prefer native
tools), not for the lowest token cost. Each MCP call carries protocol overhead
(tool schemas in context, structured `tool_use`/`tool_result` round-trips), so
in a pilot agent run the same task cost noticeably more tokens via MCP than via
the `agentrail context` **CLI** (which returns compact plain text through the
shell the agent already has). When token budget is the priority, point agents at
the CLI (see `.agentrail/agents/agent-instructions.md` in an installed project,
or `agentrail/templates/docs/agents/agent-instructions.md` for the source);
use the MCP when you want a native, enforceable tool surface. See
`docs/benchmarks/agent-ab-protocol.md`.
