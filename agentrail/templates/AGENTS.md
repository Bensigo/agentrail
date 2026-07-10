# AGENTS.md

Claude Code, Codex, and other agent harnesses read `AGENTS.md` at the
repository root automatically. AgentRail keeps its full operating rules
under `.agentrail/` and uses this file only as a cross-tool pointer.

Read, in this order, before non-trivial work:

1. `.agentrail/context.md` — project purpose, users, and architecture.
2. `.agentrail/taste.md` — product/UI/interaction quality bar, when present.
3. `.agentrail/agents/agent-instructions.md` — identity, operating rules,
   workflow skills, issue and PR conventions, quality bar, and the
   enforced context-retrieval workflow.

Do not duplicate that content here. If you need to change operating rules,
edit the files under `.agentrail/agents/`, not this pointer.
