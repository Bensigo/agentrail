# Context Retrieval CLI Benchmark & Hard Enforcement Feasibility Spike

> This document has two parts.
>
> **Part 1** is the context-retrieval benchmark summary — how AgentRail context tools
> compare to raw grep/read on token cost and ranking quality. The full, reproducible
> numbers live in `docs/benchmarks/results/context-retrieval-cli-latest.md`.
>
> **Part 2** is the hard-enforcement feasibility spike for issue #332: can the AFK
> runner restrict the agent's direct file search/read tools and route them through
> AgentRail? This is the last tier of a three-level enforcement ladder.

---

## Part 1 — Context Retrieval: Benchmark Summary

### Enforcement Levels

Three levels of progressively harder enforcement prevent agents from falling back into
`search → read full file → read another full file` loops:

| Level | Mechanism | Status |
|-------|-----------|--------|
| **Soft** | Instructions + AgentRail CLI pre-injected into prompt | Shipped |
| **Medium** | AgentRail MCP tools (#330) + review gate that rejects context-lazy PRs (#331) | In progress |
| **Hard** | AFK sandbox restricts direct file tools; all context access routed through AgentRail | This spike — see Part 2 |

Hard enforcement is the only level that *structurally prevents* full-file exploration
loops. The other levels reduce the likelihood; they cannot guarantee it.

### Key Numbers (from `results/context-retrieval-cli-latest.md`)

| strategy | tokens to gather context |
|----------|--------------------------|
| naive (grep + read every matched file in full) | 19,116,382 |
| smart agent (reads only the right files, in full) | 52,249 |
| **AgentRail context tools (line ranges)** | **5,797 (−89% vs smart)** |

Precision@1: 82% across 11 symbol queries (express + flask).

---

## Part 2 — Hard Enforcement Feasibility Spike

**Issue:** #332
**Date:** 2026-06-10
**Blocked by:** #330 (MCP tools), #331 (review gate)

### Goal

Determine whether the AFK runner (`agentrail/afk/runner.py`) can intercept or restrict
the coding agent's direct file search/read tools and route them through AgentRail
context retrieval, so an agent cannot fall back into a full-file exploration loop.

### Investigated Approaches

#### Approach A — CLI flags on the agent command

**Where in runner.py:** `_agent_command()` at line 46–49.

```python
def _agent_command(engine: str) -> str:
    if engine == "codex":
        return "codex exec --sandbox danger-full-access -"
    return "claude -p --dangerously-skip-permissions"
```

**Findings:**

- `claude -p --dangerously-skip-permissions` is designed to grant the agent *all*
  tool permissions without interactive confirmation. There is no documented flag to
  selectively deny the `Read`, `Glob`, or `Bash` built-in tools while keeping `Edit`
  and `Write`.
- `codex exec --sandbox danger-full-access` similarly grants unrestricted filesystem
  access. The Codex sandbox modes (`full-access`, `read-only`, `no-access`) are
  coarse-grained; `read-only` would block all writes, not just full-file reads used
  for context gathering.
- Neither CLI exposes a tool-specific allowlist/denylist flag.

**Verdict: Not feasible via CLI flags.**

#### Approach B — Environment-variable / config injection

Both CLIs respect a few environment variables (e.g. `ANTHROPIC_MODEL`, `CLAUDE_CONFIG`
for Claude), but none of these control which built-in tools are available. There is no
documented env-var mechanism to disable the `Read` or `Glob` tools while the agent runs.

**Verdict: Not feasible via environment injection.**

#### Approach C — MCP proxy (intercept tool calls at the protocol layer)

The Model Context Protocol allows a server to expose tools. If the runner started an
**MCP server that wraps** the file tools (Read, Glob, Grep), it could:
1. Intercept every `read_file` / `glob` / `search` call.
2. Enforce a per-session quota, redirect to `agentrail context get`, or reject whole-file
   reads above a size threshold.
3. Allow explicit whole-file requests (escape hatch) via a special tool or parameter.

This is technically feasible but has significant prerequisites:

| Prerequisite | Status |
|-------------|--------|
| AgentRail MCP server with context tools (#330) | In progress |
| Claude / Codex launched with `--mcp-server` pointing to the proxy | Requires runner change |
| The proxy must pass through `Edit`, `Write`, `Bash` unchanged | Design work needed |
| Escape hatch for intentional whole-file reads (`read_file_full` tool) | Design work needed |

When #330 ships, the runner could be modified in `_agent_command()` or `_implement()`
to add `--mcp-server <agentrail-mcp-socket>` and the MCP server could enforce quotas.
This is the **recommended future path**.

**Verdict: Technically feasible, but requires #330 to ship first and non-trivial runner
changes. Not ready to implement now.**

#### Approach D — OS-level filesystem sandbox (chroot / seccomp / landlock)

Wrapping the agent process in a filesystem sandbox (Linux `landlock`, `seccomp`,
container with bind mounts, macOS `sandbox-exec`) could restrict reads to an allowlist
of paths. The agent would be forced to go through a FUSE-mount or HTTP proxy for other
files.

**Blockers:**

- Requires OS privileges and root/`cap_sys_admin` in typical CI environments.
- Complicates the git worktree setup: the worktree is a regular directory; a
  filesystem sandbox would need to know the allowed paths ahead of time, but agents
  need to read their own tool binaries, Python stdlib, etc.
- macOS `sandbox-exec` profiles are deprecated and fragile; Linux landlock requires
  kernel 5.13+ and explicit per-file-type rule sets.
- The additional complexity and privilege requirements far outweigh the benefit at
  this stage.

**Verdict: Not feasible as a near-term option. Flag as a long-term direction only.**

### Summary of Findings

| Approach | Feasible now? | Notes |
|----------|---------------|-------|
| A — CLI flags | No | No per-tool deny flags exist on either CLI |
| B — Env injection | No | No env-var controls built-in tool availability |
| C — MCP proxy | Yes, after #330 | Recommended future path; requires runner changes |
| D — OS sandbox | No (near-term) | Privilege requirements; disproportionate complexity |

### Recommendation: Interim Enforcement Ceiling

Hard enforcement is **not feasible today**. The blocking constraints are:

1. Neither `claude -p --dangerously-skip-permissions` nor `codex exec --sandbox
   danger-full-access` allows per-tool denial.
2. The MCP-proxy approach (Approach C) is the only viable path and it depends on
   #330 landing first.

**Recommended interim ceiling: MCP tools (#330) + review gate (#331).**

This means:
- The agent is offered AgentRail context tools via MCP (soft coercion — better tools
  win on token cost).
- The review gate rejects PRs where the run log shows context-lazy behaviour (full-file
  reads with no AgentRail calls).
- Hard enforcement (Approach C, MCP proxy as gate) is deferred until #330 ships and
  the proxy design is specified.

### Sketch: Future MCP Proxy Integration

When #330 ships, the implementation touchpoint in `runner.py` is `_implement()` at
lines 121–130:

```python
async def _implement(self, slot: int, issue: int) -> bool:
    wt = self._worktree(slot, issue)
    self._setup_worktree(wt, f"origin/{self.base}")
    rc = await _sh(
        [self.agentrail, "run", "issue", str(issue), "--agent", self.engine,
         "--target", str(wt), "--command", _agent_command(self.engine)],
        ...
    )
```

And `_agent_command()` at lines 46–49 would gain an `--mcp-server` flag (or equivalent)
pointing to the enforcing proxy:

```python
# Future sketch — not implemented
def _agent_command(engine: str, mcp_socket: str | None = None) -> str:
    mcp_flag = f" --mcp-server {mcp_socket}" if mcp_socket else ""
    if engine == "codex":
        return f"codex exec --sandbox danger-full-access{mcp_flag} -"
    return f"claude -p --dangerously-skip-permissions{mcp_flag}"
```

The proxy MCP server would:
- Wrap `read_file` with a size check: reject reads above a threshold (e.g. 500 lines)
  unless the caller passes `{"full": true}` as the escape hatch.
- Log every interception as an Audit Event.
- Pass `edit_file`, `write_file`, `bash` through unchanged.

This design is a follow-on issue and should not be implemented until #330 is merged
and the review gate (#331) is operational.

### Evidence Record (AC coverage)

| AC | Status | Evidence |
|----|--------|----------|
| AC1: spike documents whether the runner can restrict agent file tools | Done | This document, Part 2 |
| AC2: if feasible — direct reads routed through AgentRail | N/A | Not feasible today (see above) |
| AC3: if not feasible — written record of blocker + interim ceiling | Done | "Recommendation" section above |
