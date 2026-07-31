// fetch_changes — one of the debugger's TWO deep-mode evidence-verb tools
// (Task 9, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501): "what changed in this window that could plausibly affect the
// failing surface" — deploys, merged PRs, config edits, migrations, across
// every credentialed `changes`-shaped provider for this workspace (github,
// railway, factory — the internal, always-on adapter over the factory's own
// runs). Thin zod-input wrapper over the shared
// `lib/evidence_verbs.core.mjs`; `search_events.ts` (this file's only
// sibling) differs solely in the literal `verb` it passes in — every other
// concern (URL building, the closed degradation taxonomy, rendering) lives
// once, in the shared core.
//
// WHEN TO CALL THIS YOURSELF vs. dispatching the nested `change`
// investigator (Task 10): a single narrow discriminating question ("did
// anything deploy in this window?") is cheaper and faster as a direct call
// here. A full "what changed" sweep — ranking candidates by plausibility
// against the repo's system model — is the `change` investigator's job, not
// this tool's; see instructions.md's Deep mode section.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate.
//  - The network reach is exactly one endpoint via the global `fetch`. The
//    host/path come from configured env, never from model input.
//  - On unset config, an unreachable/failing console, or a request-level
//    problem (no anchored investigation, no credentialed provider) it
//    returns a DEGRADED result (never throws, never retries).
//  - Returned evidence excerpts are advisory/untrusted, hardened before this
//    subagent ever reads them (see lib/evidence_verbs.core.mjs).
//
// SESSION RESOLUTION: `ctx.session.parent?.rootSessionId ?? ctx.session.id`
// — the debugger runs as a declared child session (its OWN `ctx.session.id`
// has no `jace_sessions` row), same seam
// fetch_investigations.ts/save_investigation.ts already use.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchEvidence } from "../lib/evidence_verbs.core.mjs";

// A wedged/unresponsive console must not hang the round for minutes (mirrors
// fetch_investigations.ts's own fix for this).
const FETCH_TIMEOUT_MS = 10_000;

// The REAL transport: one GET via the global fetch, narrowed to the
// { status, json } shape the core expects. Injected exactly as
// fetch_investigations.ts injects its real driver, so the core stays
// hermetic in tests.
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

export default defineTool({
  description:
    "Ask 'what changed in this window that could plausibly affect the failing surface': deploys, merged PRs, " +
    "config edits, migrations — across every credentialed changes provider for this workspace (github, " +
    "railway, and the always-on internal factory adapter over this app's own runs). Call this DIRECTLY for a " +
    "single narrow question during a round; for a full ranked sweep, dispatch the nested change investigator " +
    "instead. windowStart/windowEnd (ISO-8601, both REQUIRED — every evidence query is scoped to a window) " +
    "bound the search; scope optionally narrows within a provider (e.g. a repo or service name); limit caps " +
    "how much comes back before the envelope's own size caps. " +
    "\n\n" +
    "Never throws. A request-level problem (this conversation has no investigation anchored yet, no provider " +
    "is credentialed for changes, a malformed call) comes back as a degraded result with a reason from a " +
    "closed ten-value taxonomy — report it as an honest evidence gap, exactly like fetch_run_evidence's " +
    "degraded results in run mode; never invent a cause. A successful call returns `envelopes` (each with a " +
    "`ref` you cite in a finding's or proposed hypothesis's evidence_refs) and `degradations` (providers that " +
    "could not answer THIS call) — both arrays are always present; read both, and report any non-empty " +
    "degradations as a gap even when other providers succeeded.",
  inputSchema: z.object({
    windowStart: z
      .string()
      .min(1)
      .describe("ISO-8601 start of the time window to search, e.g. '2026-07-29T13:30:00Z'. Required."),
    windowEnd: z.string().min(1).describe("ISO-8601 end of the time window. Required."),
    scope: z
      .string()
      .optional()
      .describe("Narrow within a provider — e.g. a repo name or service — optional."),
    query: z
      .string()
      .optional()
      .describe("Free-text filter, if you want to narrow which changes come back — optional."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Cap how many results come back, before the envelope's own size caps — optional."),
  }),
  async execute(input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return fetchEvidence({
      eveSessionId,
      verb: "changes",
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      scope: input.scope,
      query: input.query,
      limit: input.limit,
      env: process.env,
      transport: realTransport,
    });
  },
});
