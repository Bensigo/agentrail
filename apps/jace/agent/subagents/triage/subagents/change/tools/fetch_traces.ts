// fetch_traces — one of this investigator's FOUR evidence-verb tools
// (fetch_changes/search_events shipped Task 10, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501; fetch_signals/fetch_traces widen this to four by Task P1, Evidence
// Providers Wave 2: .superpowers/sdd/plan-providers.md): "show me a single
// request's path through the system in this window" — exemplar
// traces/spans, their duration and status — across every credentialed
// traces provider for this workspace. Thin zod-input wrapper over this
// investigator's OWN copy of `lib/evidence_verbs.core.mjs` (Eve subagents
// share nothing — this file's siblings `fetch_changes.ts`/
// `search_events.ts`/`fetch_signals.ts` differ solely in the literal `verb`
// each passes in; every other concern — URL building, the closed
// degradation taxonomy, rendering — lives once, in the copied core). The
// core does NOT re-format span data — the rendered excerpt IS the adapter's
// own pre-rendered trace lines (plan-providers.md's pinned convention), a
// provider-adapter concern, not this tool's.
//
// This investigator answers ONE question the debugger handed it: a full
// "what changed" sweep. `fetch_changes` is the primary way it gathers that
// evidence, `search_events` a secondary source; `fetch_traces` is here to
// CONFIRM a candidate's impact — an exemplar request that started failing
// (or slowing down) at the exact point the deploy touched is stronger
// evidence than the deploy timestamp alone.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate.
//  - The network reach is exactly one endpoint via the global `fetch`. The
//    host/path come from configured env, never from model input.
//  - On unset config, an unreachable/failing console, or a request-level
//    problem (no anchored investigation, no credentialed provider) it
//    returns a DEGRADED result (never throws, never retries).
//  - Returned evidence excerpts are advisory/untrusted, hardened before this
//    investigator ever reads them (see lib/evidence_verbs.core.mjs).
//
// SESSION RESOLUTION: `ctx.session.parent?.rootSessionId ?? ctx.session.id`
// — this investigator runs as a declared child session, nested two levels
// under root (root -> triage -> change), and its OWN `ctx.session.id` has
// no `jace_sessions` row, same seam every fetch/save tool in this codebase
// already uses.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchEvidence } from "../lib/evidence_verbs.core.mjs";

// A wedged/unresponsive console must not hang the round for minutes (mirrors
// the debugger's own fetch_traces.ts fix for this).
const FETCH_TIMEOUT_MS = 10_000;

// The REAL transport: one GET via the global fetch, narrowed to the
// { status, json } shape the core expects. Injected exactly as the
// debugger's own fetch_traces.ts injects its real driver, so the core stays
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
    "Ask 'show me a single request's path through the system in this window': exemplar traces/spans, their " +
    "duration and status — across every credentialed traces provider for this workspace — useful here to " +
    "confirm a change candidate's impact (did requests actually start failing or slowing down at the exact " +
    "point the deploy touched?). windowStart/windowEnd (ISO-8601, both REQUIRED — every evidence query is " +
    "scoped to a window) bound the search; scope optionally narrows within a provider (e.g. a service name); " +
    "query optionally narrows which trace/span comes back (e.g. an operation name); limit caps how much comes " +
    "back before the envelope's own size caps. " +
    "\n\n" +
    "Never throws. A request-level problem (this conversation has no investigation anchored yet, no provider " +
    "is credentialed for traces, a malformed call) comes back as a degraded result with a reason from a " +
    "closed ten-value taxonomy — report it in your `degraded` output verbatim, never invent a cause. A " +
    "successful call returns `envelopes` (each with a `ref` you cite in a candidate's evidence_refs) and " +
    "`degradations` (providers that could not answer THIS call) — both arrays are always present; read both, " +
    "and report any non-empty degradations as a gap even when other providers succeeded.",
  inputSchema: z.object({
    windowStart: z
      .string()
      .min(1)
      .describe("ISO-8601 start of the time window to search, e.g. '2026-07-29T13:30:00Z'. Required."),
    windowEnd: z.string().min(1).describe("ISO-8601 end of the time window. Required."),
    scope: z
      .string()
      .optional()
      .describe("Narrow within a provider — e.g. a service name — optional."),
    query: z
      .string()
      .optional()
      .describe("Free-text filter, if you want to narrow which trace/span comes back (e.g. an operation name) — optional."),
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
      verb: "traces",
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
