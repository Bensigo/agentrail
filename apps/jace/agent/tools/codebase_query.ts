// codebase_query — Jace's READ-ONLY window onto a LOCAL AgentRail checkout.
//
// RUNTIME AVAILABILITY (observed in prod 2026-07-27, hence this note): this
// tool works ONLY where Jace runs beside a repo checkout — i.e. self-hosted or
// local dev. In the hosted deployment it always fails, and installing `git`
// would NOT fix it:
//
//   1. apps/jace/Dockerfile deliberately ships no git and no gh ("no git, no
//      gh, no Docker socket") — Jace's only outside-world write path is a pure
//      Python urllib REST call, so VCS tooling is excluded on purpose.
//   2. More fundamentally, that image contains NO checkout to search. Jace is
//      multi-tenant — one process serving every workspace's conversations —
//      so there is no single repo it could clone.
//
// The hosted path for the same questions is `fetch_repo_wiki`, which reads the
// compiled wiki over HTTP and is tenant-scoped by construction. Both tool
// descriptions state this split, because the model previously chose between
// them at random: on 2026-07-27 the same class of question routed to
// fetch_repo_wiki on Discord (worked) and to this tool on Telegram (failed
// with "No such file or directory: 'git'"). Keep the descriptions
// disambiguated if you touch either.
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
    "SELF-HOSTED ONLY — requires a local repo checkout plus the `agentrail` " +
    "CLI and `git` on this same machine. The hosted deployment has NEITHER " +
    "(apps/jace/Dockerfile installs no git and clones no repo, deliberately), " +
    "so this tool CANNOT work there and calling it only produces an error. " +
    "For any question about a workspace's connected repo — including " +
    "AgentRail's own — use `fetch_repo_wiki` instead; it reads the compiled " +
    "wiki over HTTP and works everywhere. Only reach for this tool when you " +
    "already know you are running beside a checkout and the wiki has no " +
    "answer. `sub` selects the retrieval verb: 'query' for a natural-language " +
    "question, 'def' for a symbol's definition, 'callers' for who calls a " +
    "symbol. Only these read-only verbs are allowed. The subprocess is run " +
    "execFile-style with an args array (never a shell string); it writes " +
    "nothing and needs no approval. Answer ONLY from the returned citations " +
    "— never from memory.",
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
