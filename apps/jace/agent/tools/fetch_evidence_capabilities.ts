// fetch_evidence_capabilities — the coordinator's READ-ONLY window onto the
// EVIDENCE CAPABILITY MAP: which evidence verbs this workspace's connected
// providers can actually answer right now (debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501). Structural sibling of fetch_investigations.ts — same
// session-resolution defense, same least-privilege posture — but a
// single-mode, NO-PARAMETER tool: the capability map is workspace-wide, not
// investigation- or query-scoped, so there is nothing for the model to
// supply beyond calling it.
//
// This is the tool that answers "what CAN I look at" — call it once at
// intake (during the witness interview, before the first round), so the
// capability-first framing ("I can inspect deployments (github, railway)")
// is grounded in the real, current provider mix instead of assumed. It
// needs NO anchored investigation — see the console route's own doc-comment:
// "a capability check is 'what could I look at', asked before any
// investigation necessarily exists yet."
//
// SESSION RESOLUTION — same reasoning as every other root investigation
// tool (read fetch_investigations.ts's own comment for the full
// explanation): resolves `ctx.session.parent?.rootSessionId ?? ctx.session.id`.
//
// Least privilege by construction:
//  - It writes NOTHING and sets NO `approval` — read-only tools do not gate.
//  - The network reach is exactly one endpoint via the global `fetch`. The
//    host/path come from configured env, never from model input.
//  - On unset config, an unreachable/failing console, or a not-yet-deployed
//    route it returns a DEGRADED result (never throws, never retries).
//  - Provider identifiers are defensively hardened before the model reads
//    them, same as every other externally-sourced string on this surface.

import { defineTool } from "eve/tools";
import { z } from "zod";
import { fetchEvidenceCapabilities } from "../lib/fetch_evidence_capabilities.core.mjs";

// A wedged/unresponsive console must not hang the chat turn for minutes
// (mirrors fetch_investigations.ts's own fix for this).
const FETCH_TIMEOUT_MS = 10_000;

// The REAL transport: one GET via the global fetch, narrowed to the { status,
// json } shape the core expects. Injected exactly as every sibling tool
// injects its real driver, so the core stays hermetic in tests.
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
    "Read the EVIDENCE CAPABILITY MAP for this workspace — which evidence " +
    "verbs (changes, search_events, signals, traces, probe) have at least " +
    "one connected, credentialed provider right now, and which do not. " +
    "Takes NO parameters: the map is workspace-wide, not scoped to any " +
    "investigation or query, and needs no anchored investigation to call. " +
    "Call this ONCE, at intake — before or during the witness interview, " +
    "before the first round — so the capability-first framing you give the " +
    "human ('I can inspect deployments (github, railway)') reflects what is " +
    "ACTUALLY connected instead of an assumption. Also call it before " +
    "composing a mission envelope's capability map for a round, rather than " +
    "asserting one from memory or an earlier call in the conversation — the " +
    "connector mix can change between turns." +
    "\n\n" +
    "Rendered capability-first: one line per verb, provider names riding " +
    "along only as a parenthetical attribution on evidence that exists — " +
    "'I can inspect deployments and merges (github, railway).' A verb with " +
    "nothing connected renders as an honest gap, never a bare empty list — " +
    "'I cannot inspect metrics yet — no provider is connected.' Voice this " +
    "gap in chat at most twice per the capability-voice discipline (once at " +
    "intake, once more only if it concretely blocks a step) even though the " +
    "tool itself can be called as often as needed." +
    "\n\n" +
    "Read-only; writes nothing and needs no approval. Returns a degraded " +
    "result (never throws) when the console is unconfigured, unreachable, " +
    "or erroring; treat that as an honest gap in THIS fetch, never a reason " +
    "to guess at what is or isn't connected.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const eveSessionId = ctx?.session?.parent?.rootSessionId ?? ctx?.session?.id;
    return fetchEvidenceCapabilities({
      eveSessionId,
      env: process.env,
      transport: realTransport,
    });
  },
});
