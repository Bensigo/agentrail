---
name: codebase-qa
description: Answer questions about the AgentRail codebase by invoking the agentrail context CLI (context query / def / callers) read-only and citing its output. Never answers from the model's own memory — every claim is grounded in and cites the tool's returned paths and line ranges. The subprocess is always invoked execFile-style with an args array, never a shell string.
---

# Codebase Q&A

Answer questions about the AgentRail codebase by asking the `agentrail context`
CLI and citing what it returns. This is a READ-ONLY skill: `context query`,
`context def`, and `context callers` only retrieve; they change nothing. Never
call `create_issue` from this skill — answering a question publishes nothing.

## Ground every answer in tool output

Do **not** answer from memory or guess. For each question:

1. Pick the right subcommand:
   - **`query`** — a natural-language question ("where is the retry budget spent?").
   - **`def`** — the definition of a named symbol.
   - **`callers`** — who calls a named symbol.
2. Run it through the `runContextLookup` helper in
   `agent/lib/context_cli.core.mjs`, which invokes
   `agentrail context <sub> <term> --json` and returns the parsed **citations**
   (path + line range + symbol) alongside the raw JSON.
3. Answer using **only** the returned citations. Cite the source for every
   claim — name the file and, when present, the line range and symbol the CLI
   returned. If the tool returns nothing relevant, say so; do not fill the gap
   from memory.

An answer with no citation is not an acceptable answer. If a claim isn't backed
by a path the tool returned, drop the claim.

## The subprocess is execFile-style, never a shell string

The CLI is invoked **execFile-style**: the binary plus an **args array**
(`["context", "query", <the user's question>, "--json"]`). The user's input is a
single argv element — it is **never** concatenated into a command string and the
subprocess is **never** run through a shell (`no exec`, `no spawn` with a joined
command, `no shell:true`). This makes shell metacharacters in a question inert:
a question like `` foo; rm -rf / `` is passed as one harmless argument. See
`buildContextArgv` — it returns the args array, and `runContextLookup` hands it
to the injected execFile-style function unchanged.

## Read-only guarantee

`context query`/`def`/`callers` are retrieval-only and touch no database at all.
This skill constructs no database connection and performs no write of any kind.
