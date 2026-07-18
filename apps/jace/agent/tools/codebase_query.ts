// codebase_query — Jace's READ-ONLY window onto the AgentRail codebase.
//
// This tool answers questions about the code by shelling out to the existing
// `agentrail context` CLI (query / def / callers) and returning its output so the
// model can cite it. It is READ-ONLY on two counts:
//   1. It only ever runs the retrieval subcommands in ALLOWED_SUBCOMMANDS — an
//      allowlist of read-only `agentrail context` verbs. Any other subcommand is
//      rejected before a subprocess is spawned.
//   2. The subprocess is invoked execFile-style with an ARGS ARRAY (via the real
//      promisified execFile injected below), never a shell string and never
//      shell:true (AC4). The user's question is a single argv element, so shell
//      metacharacters in it are inert.
//
// It writes nothing, so — unlike the gated write tools (create_issue,
// create_workspace, create_repo) — it sets NO `approval`. Human approval is
// reserved for the mutating tools.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  runContextLookup,
  ALLOWED_SUBCOMMANDS,
} from "../lib/context_cli.core.mjs";

// The REAL promisified execFile, injected into runContextLookup exactly as
// create_issue injects it into runCreateIssue: execFile takes (bin, ARGS ARRAY,
// opts) and NEVER a shell string. This is the app's only shell-out capability in
// a read-only tool, and it is args-array by construction.
const execFileAsync = promisify(execFile);

// Zod enum built directly from the core's allowlist so the tool and the core can
// never drift: the only subcommands the model may request are the read-only ones
// the core also enforces. `agentrail context` supports these as read-only,
// retrieval-only verbs (query / def / callers) — see `agentrail context --help`.
const subcommandSchema = z.enum(
  ALLOWED_SUBCOMMANDS as unknown as [string, ...string[]],
);

export default defineTool({
  description:
    "Answer a question about the AgentRail codebase by invoking the READ-ONLY " +
    "`agentrail context` CLI and citing its output. `sub` selects the retrieval " +
    "verb: 'query' for a natural-language question, 'def' for a symbol's " +
    "definition, 'callers' for who calls a symbol. Only these read-only verbs " +
    "are allowed. The subprocess is run execFile-style with an args array (never " +
    "a shell string); it writes nothing and needs no approval. Answer ONLY from " +
    "the returned citations — never from memory.",
  inputSchema: z.object({
    sub: subcommandSchema.describe(
      "Read-only agentrail context subcommand: query | def | callers.",
    ),
    term: z
      .string()
      .min(1)
      .describe(
        "The question (for 'query') or symbol name (for 'def'/'callers'). " +
          "Passed to the CLI as ONE argv element — shell metacharacters are inert.",
      ),
  }),
  async execute(input) {
    // runContextLookup re-validates `sub` against ALLOWED_SUBCOMMANDS and builds
    // the args array; the real execFile runs it with no shell. The result carries
    // the parsed citations AND the raw stdout so answers cite tool output (AC3).
    const { argv, citations, raw } = await runContextLookup({
      execFileFn: execFileAsync,
      sub: input.sub as (typeof ALLOWED_SUBCOMMANDS)[number],
      term: input.term,
      env: process.env,
    });
    return { argv, citations, raw };
  },
});
