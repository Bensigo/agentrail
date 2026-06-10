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

Each tool shells out to the existing `agentrail context …` CLI, so retrieval
behaviour has a single source of truth.

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
the CLI (see `templates/AGENTS.md`); use the MCP when you want a native,
enforceable tool surface. See `docs/benchmarks/agent-ab-protocol.md`.
