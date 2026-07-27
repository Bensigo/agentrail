// standup — Jace's READ-ONLY window onto the running AgentRail factory.
//
// This is a read-only reporting tool: it reads the workspace-scoped console
// route (agent/lib/fetch_work_status.core.mjs, GET /api/v1/runner/work-status)
// and renders a standup of ONLY schema-backed facts (run counts by state,
// total cost, open PR links, human escalations, queue states). It NEVER
// narrates why a run failed — the runs table has no error/reason column, so a
// "why did it fail" question is answered honestly with no source (AC1/AC2).
//
// It used to open the AgentRail Postgres database directly through a hard
// read-only edge (the now-deleted agent/lib/standup.db.mjs). That edge was
// retired for two reasons:
//   1. Its query was `SELECT … FROM runs ORDER BY created_at DESC LIMIT 500`
//      — no `WHERE`, no workspace filter. It was the only Jace tool that
//      opened Postgres directly instead of going through the console's
//      `/api/v1/runner/*` seam, so it read every workspace's runs, bypassing
//      the tenant resolution every other Jace tool uses.
//   2. It was dark in production: it resolved `DATABASE_URL`, which the jace
//      service does not set, so it silently fell back to a localhost URL and
//      could never actually connect.
// Re-pointing standup at fetchWorkStatus fixes both: the console route
// resolves the real workspace server-side from `ctx.session.id` (via the
// jace_sessions ledger), and it removes the `DATABASE_URL` dependency
// entirely — standup no longer touches Postgres from Jace at all.
//
// It performs NO write of any kind, so — unlike the gated write tools
// (create_issue, create_workspace, create_repo) — it sets NO `approval`. Human
// approval is reserved for the mutating tools; making a read-only report pause
// for approval would be noise.

import { defineTool } from "eve/tools";
import { z } from "zod";
// NOTE (verified against installed eve@0.19.0, mirrors create_issue.ts):
//  - `defineTool` from "eve/tools" is the tool-authoring helper; the tool is the
//    file's DEFAULT export and its runtime name is the filename slug (`standup`),
//    so there is no `name` field.
//  - This tool sets NO `approval` — it is read-only. Approval gates are
//    reserved for the mutating tools (create_issue, create_workspace,
//    create_repo).
import { fetchWorkStatus } from "../lib/fetch_work_status.core.mjs";
import { buildStandupOutcome } from "../lib/standup.core.mjs";

// The REAL transport: one GET via the global fetch, narrowed to the { status,
// json } shape fetchWorkStatus expects. Injected exactly as fetch_work_status
// injects its real driver, so the core stays hermetic in tests. Mirrored
// verbatim from agent/tools/fetch_work_status.ts's realTransport.
// A wedged/unresponsive console must not hang the chat turn for minutes
// (Minor 11) — the resulting AbortError throw already maps to
// degraded("unreachable") in fetchWorkStatus's try/catch, so this needs no
// extra handling here.
const FETCH_TIMEOUT_MS = 10_000;

async function realTransport(
  url: string,
  init: { headers: Record<string, string> },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const res = await fetch(url, {
    method: "GET",
    headers: init.headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, json: () => res.json() };
}

// Request the route's own maximum page size (1..200, see the route's
// LIMIT_MAX) — standup wants as complete a snapshot as the route allows, not
// its default page (50). The route owns the clamp; this tool never re-clamps.
const STANDUP_LIMIT = 200;

export default defineTool({
  description:
    "Report a READ-ONLY standup of the AgentRail factory, scoped to this " +
    "workspace, using ONLY schema-backed facts: run counts by state, total " +
    "cost, open PR links, human escalations, and queue states. It writes " +
    "nothing and needs no approval. It never invents WHY a run failed — the " +
    "runs table has no error/reason column, so a failure reason is honestly " +
    "reported as unavailable (pass whyFailedRunId to get that honest " +
    "no-source answer for a specific run).",
  inputSchema: z.object({
    whyFailedRunId: z
      .string()
      .optional()
      .describe(
        "If set, answer a 'why did run X fail' question HONESTLY for this run " +
          "id: there is no failure-detail source, so report only what IS known " +
          "(state, cost, PR link) and never a confabulated reason.",
      ),
  }),
  async execute(input, ctx) {
    // fetchWorkStatus resolves the real workspace server-side from
    // ctx.session.id (never a model-supplied argument — see the global
    // constraint that this tool never accepts a workspaceId). `ref` is
    // omitted (list mode); `limit` requests the route's own maximum so the
    // standup sees as complete a snapshot as the route allows.
    const status = await fetchWorkStatus({
      env: process.env,
      eveSessionId: ctx.session.id,
      ref: "",
      limit: STANDUP_LIMIT,
      transport: realTransport,
    });

    // Important 4: whyFailedRunId is resolved via a targeted fetch with
    // `ref: whyFailedRunId` — the route's ref mode resolves a run id
    // EXACTLY and unpaginated (findWorkspaceWorkByRef's `run-id` branch),
    // unlike the aggregate call above, which only ever sees STANDUP_LIMIT's
    // page. Without this, a failed run older than that page would look
    // identical to "no such run" — a silent truncation, not an honest gap.
    // Skipped when the aggregate call above is already degraded:
    // buildStandupOutcome returns a degraded `status` verbatim without ever
    // looking at whyFailedStatus, so firing this against an already-down
    // console would just be a wasted second call.
    //
    // Minor 7: the run is often already sitting in `status.runs` (the
    // common case — a recent failure well inside the aggregate's
    // STANDUP_LIMIT page). Search there FIRST and only pay for the second
    // round-trip on a miss — two sequential 10s-timeout fetches otherwise
    // fire on every whyFailedRunId call, so a wedged console holds the turn
    // ~20s even when the answer was already in hand. buildStandupOutcome
    // requires a `whyFailedStatus` whenever `whyFailedRunId` is set (Minor
    // 5), so the in-hand case still builds one — just from the row already
    // fetched, with the same `{ ok: true, runs: [...] }` shape a real
    // dedicated fetch would return, so buildStandupOutcome can't tell (and
    // doesn't need to) which happened.
    let whyFailedStatus: Awaited<ReturnType<typeof fetchWorkStatus>> | undefined;
    if (input.whyFailedRunId && status.ok === true) {
      const inHand = (Array.isArray(status.runs) ? status.runs : []).find(
        (r: { id?: string }) => r && r.id === input.whyFailedRunId,
      );
      whyFailedStatus = inHand
        ? ({ ok: true, runs: [inHand], queueEntries: [] } as Awaited<
            ReturnType<typeof fetchWorkStatus>
          >)
        : await fetchWorkStatus({
            env: process.env,
            eveSessionId: ctx.session.id,
            ref: input.whyFailedRunId,
            transport: realTransport,
          });
    }

    // All the orchestration — degraded passthrough (never an empty standup
    // that would lie by reading as "nothing is running"), truncation honesty
    // threaded into the rendered text, and the honest no-source
    // whyFailedRunId lookup (AC2) — lives in the pure, unit-tested
    // buildStandupOutcome so it never has to be exercised through a live
    // fetch or a mocked module.
    return buildStandupOutcome({
      status,
      whyFailedRunId: input.whyFailedRunId,
      whyFailedStatus,
    });
  },
});
