# @agentrail/mcp

MCP server that exposes AgentRail's compact context retrieval as native tools, so
coding agents (Claude, Cursor, Codex, …) prefer it over raw file search/read —
the MCP/tool-enforcement level from
`docs/benchmarks/context-retrieval-cli-benchmark.md`.

## Tools

| Tool | Maps to | Returns |
| --- | --- | --- |
| `context_search` | `agentrail context search` | ranked path + line range + symbol + bounded snippet + reason + score |
| `context_get` | `agentrail context get` | only the requested line range / symbol block — never the whole file |
| `context_build_pack` | `agentrail context build` | a bounded context pack for an issue/PR phase |
| `context_explain_pack` | `agentrail context explain` | why sources were included / excluded / boosted / demoted |
| `acceptance_intake_start` | Jace API | records a raw task with MCP-task provenance; never creates a contract or authorizes implementation |
| `acceptance_intake_get` | Jace API | bounded task-context messages and compact contract status; never a raw transcript |
| `acceptance_intake_reply` | Jace API | forwards an explicit task-context user reply idempotently; never writes a contract |
| `acceptance_record_get` | Jace API | draft/confirmed contract for an existing record |
| `acceptance_context_pack_record` | Jace API | context-pack metadata and artifact references only |
| `acceptance_builder_task_get` | Jace API | the recorded builder task's confirmed contract and selected bounded Context Pack |
| `correction_deliveries_get` | Jace API | evidence-bound corrections for the recorded builder task; not proof of receipt |
| `correction_delivery_acknowledge` | Jace API | agent receipt acknowledgement only; does not modify code or merge |

Context-retrieval tools shell out to the existing `agentrail context …` CLI, so
retrieval behaviour has a single source of truth. Acceptance Record and
correction-delivery tools use Jace's scoped API; they never read the database
directly.

## Build

```bash
pnpm --filter @agentrail/mcp build   # emits dist/index.js
```

## Configuration

The server resolves:
- the AgentRail CLI from `AGENTRAIL_BIN` (default `agentrail` on `PATH`),
- the repo to operate on from the per-call `target` argument, else
  `AGENTRAIL_TARGET`, else the server's working directory.

The target repo must already be indexed (`agentrail context index`).

### Connect Jace Acceptance Records

An owner or admin creates a scoped **Agent access** credential in Jace. It is
returned once with a `jace_mcp_` prefix. Put it in an environment variable; do
not paste it into a committed MCP configuration file. The hosted boundary only
permits the scopes selected at creation. It cannot confirm contracts, merge,
deploy, run shell commands, or read another workspace.

```json
{
  "mcpServers": {
    "jace": {
      "command": "node",
      "args": ["/abs/path/to/agentrail/packages/mcp/dist/index.js"],
      "env": {
        "JACE_API_URL": "https://console.example.com",
        "JACE_WORKSPACE_ID": "workspace-uuid",
        "JACE_MCP_TOKEN": "${JACE_MCP_TOKEN}"
      }
    }
  }
}
```

Use `acceptance_intake_start` first with the raw user request and a stable MCP
task-context key. The hosted boundary derives the `mcp` origin and credential
provenance; the agent cannot select a repository or submit a contract through
this tool. Jace must collect unresolved information and a human must confirm
the Acceptance Contract before a Context Pack handoff or implementation. The
MCP server does not claim that interactive clarification or confirmation has
completed. Use `acceptance_intake_get` to read only Jace's bounded task-context
messages, then use `acceptance_intake_reply` only for an explicit user reply
with a stable source-message key. MCP task-context provenance is not an
independently authenticated human identity. When it records a Context Pack,
the API accepts only a hash,
provenance/freshness metadata, and artifact references; raw source content does
not enter the central record.

To retrieve a correction, the credential needs `acceptance:read`; to confirm
that the agent has actually received and read it, it also needs
`acceptance:correction:ack`. Retrieval is not an acknowledgement. Neither tool
changes code or merges a PR.

### Claude Code / Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "agentrail-context": {
      "command": "node",
      "args": ["/abs/path/to/agentrail/packages/mcp/dist/index.js"],
      "env": {
        "AGENTRAIL_BIN": "/abs/path/to/agentrail/scripts/agentrail",
        "AGENTRAIL_TARGET": "/abs/path/to/your/repo"
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
