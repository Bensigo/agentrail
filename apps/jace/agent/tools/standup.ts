// standup — Jace's READ-ONLY window onto the running AgentRail factory.
//
// This is a read-only reporting tool: it opens the AgentRail Postgres database
// through a hard read-only edge (agent/lib/standup.db.mjs), reads the run and
// queue snapshots, and renders a standup of ONLY schema-backed facts (run counts
// by state, total cost, open PR links, human escalations, queue states). It
// NEVER narrates why a run failed — the runs table has no error/reason column,
// so a "why did it fail" question is answered honestly with no source (AC1/AC2).
//
// It performs NO write of any kind, so — unlike the single gated create_issue
// tool — it does NOT set `approval: always()`. Human approval is reserved for the
// one mutating tool; making a read-only report pause for approval would be noise.

import { defineTool } from "eve/tools";
import { z } from "zod";
// NOTE (verified against installed eve@0.19.0, mirrors create_issue.ts):
//  - `defineTool` from "eve/tools" is the tool-authoring helper; the tool is the
//    file's DEFAULT export and its runtime name is the filename slug (`standup`),
//    so there is no `name` field.
//  - This tool sets NO `approval` — it is read-only. `approval: always()` is
//    reserved for the single mutating tool (create_issue).
import { openReadOnlyDb } from "../lib/standup.db.mjs";
import {
  buildStandup,
  renderStandup,
  answerWhyFailed,
  WHY_FAILED_NO_SOURCE,
} from "../lib/standup.core.mjs";

// The REAL postgres driver, injected into openReadOnlyDb exactly as create_issue
// injects the real promisified execFile. Importing it lazily keeps the tool
// module importable (e.g. by the tool loader) without a live database, and — as
// with create_issue's execFile — the tool wires the genuine dependency, not a
// fake. openReadOnlyDb constructs it with the read-only session guard.
async function realSqlFactory(url: string, options: Record<string, unknown>) {
  // `postgres` is a transitive dependency (via @workflow/world-postgres) and is
  // not resolvable at typecheck time; the import is intentionally dynamic.
  // @ts-ignore -- optional lazy driver import, resolved at runtime only
  const mod = await import("postgres");
  const postgres = (mod.default ?? mod) as (
    u: string,
    o: Record<string, unknown>,
  ) => unknown;
  return postgres(url, options);
}

export default defineTool({
  description:
    "Report a READ-ONLY standup of the AgentRail factory from Postgres using " +
    "ONLY schema-backed facts: run counts by state, total cost, open PR links, " +
    "human escalations, and queue states. It writes nothing and needs no " +
    "approval. It never invents WHY a run failed — the runs table has no " +
    "error/reason column, so a failure reason is honestly reported as " +
    "unavailable (pass whyFailedRunId to get that honest no-source answer for a " +
    "specific run).",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .default(500)
      .describe("Max rows to read per table (runs / queue_entries)."),
    whyFailedRunId: z
      .string()
      .optional()
      .describe(
        "If set, answer a 'why did run X fail' question HONESTLY for this run " +
          "id: there is no failure-detail source, so report only what IS known " +
          "(state, cost, PR link) and never a confabulated reason.",
      ),
  }),
  async execute(input) {
    // Open the read-only edge with the REAL postgres driver injected. The edge
    // pins the session to read-only and wraps every SELECT in a READ ONLY
    // transaction; no write-capable client is ever constructed (AC5).
    const db = await openReadOnlyDb({
      env: process.env,
      sqlFactory: realSqlFactory,
    });
    try {
      const [runs, queueEntries] = await Promise.all([
        db.fetchRuns(input.limit),
        db.fetchQueueEntries(input.limit),
      ]);

      const standup = buildStandup({ runs, queueEntries });
      const report = renderStandup(standup);

      // Honest "why did run X fail" answer, derived only from schema-backed
      // columns — never a fabricated reason (AC2).
      let whyFailed: ReturnType<typeof answerWhyFailed> | null = null;
      if (input.whyFailedRunId) {
        const run = runs.find((r) => r.id === input.whyFailedRunId);
        whyFailed = answerWhyFailed(run);
      }

      return {
        report,
        standup,
        whyFailed,
        // A stable note so the model never fills a failure-reason gap from memory.
        failureReasonPolicy: WHY_FAILED_NO_SOURCE,
      };
    } finally {
      await db.close();
    }
  },
});
