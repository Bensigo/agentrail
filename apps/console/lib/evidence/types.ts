/**
 * Evidence capability layer — shared types (Task 4, debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501; `.superpowers/sdd/spec.md` is the working copy this implementation
 * follows).
 *
 * This directory (`lib/evidence/`) is deliberately SEPARATE from the sibling
 * FILE `lib/evidence.ts` (`boundEvidence`/`EVIDENCE_MAX_LINES`/`EVIDENCE_MAX_BYTES`
 * — the log-excerpt bounding used by `runner/result`). That file's concern is
 * "cap one already-known string"; this directory's concern is "which external
 * tool can answer which kind of question, and how is its answer captured as a
 * durable, tamper-evident investigation artifact." Different concerns, same
 * general theme (evidence), hence the deliberate split rather than folding one
 * into the other. `envelope.ts` REUSES `lib/evidence.ts`'s caps rather than
 * redefining them (see that file's own doc-comment).
 *
 * A file (`lib/evidence.ts`) and a same-named directory (`lib/evidence/`)
 * coexisting is safe under this project's module resolution: TypeScript's
 * `moduleResolution: "bundler"` (and Node's own resolver, which it mirrors)
 * tries LOAD_AS_FILE before LOAD_AS_DIRECTORY for any relative specifier —
 * `../lib/evidence` resolves to the FILE unconditionally, and resolution never
 * even reaches the directory-resolution step. Directory resolution would only
 * become reachable if `lib/evidence.ts` were deleted OR the specifier were the
 * bare `../lib/evidence/` with a trailing slash (nothing in this codebase does
 * that) — and even then, this directory intentionally has NO `index.ts`, so
 * there is nothing for a bare directory import to resolve to regardless. Every
 * import into this directory (here and in every other Task 4+ file) is a fully
 * qualified subpath (`lib/evidence/types`, `lib/evidence/registry`, …), never
 * the bare `lib/evidence`. Verified empirically: `lib/evidence.test.ts`
 * (the existing file's own test) and this directory's own tests, plus
 * `runner/result/route.ts` (which imports the FILE via
 * `../../../../../lib/evidence`), all resolve and pass side by side in the
 * same test run — see the Task 4 report for the full note.
 *
 * The five verbs are the CLOSED set of question-shapes an investigation can
 * ask an external tool (spec's capability taxonomy): `changes` (what shipped —
 * deploys, merged PRs, config edits), `search_events` (find log/event lines
 * matching a term), `signals` (numeric health — error rates, latency,
 * saturation), `traces` (a single request's path through the system), `probe`
 * (an active, synchronous check — e.g. "hit this endpoint now"). v1 only ships
 * adapters for `changes`/`search_events` (Tasks 5-7); `signals`/`traces`/`probe`
 * exist in the type so a future provider needs no type-level change to adopt
 * them — only a catalog entry + an adapter (see `registry.ts`'s own
 * doc-comment for the architecture this buys).
 */

/** The closed set of evidence question-shapes (spec's capability taxonomy). */
export type EvidenceVerb =
  | "changes"
  | "search_events"
  | "signals"
  | "traces"
  | "probe";

/** Every {@link EvidenceVerb}, in the family-nesting order the capabilities route renders. */
export const EVIDENCE_VERBS: readonly EvidenceVerb[] = [
  "changes",
  "search_events",
  "signals",
  "traces",
  "probe",
];

/**
 * One evidence request. `windowStart`/`windowEnd` are REQUIRED ISO-8601
 * strings on every call — an investigation is always asking "in this window,
 * what happened" (evidence with no time bound is a scope leak waiting to
 * happen). `scope` narrows within the provider (e.g. a repo, a service name);
 * `query` is a free-text search term (`search_events` mainly); `limit` caps
 * how much the adapter returns before it even reaches the envelope's own
 * line/byte caps.
 */
export interface EvidenceQuery {
  verb: EvidenceVerb;
  windowStart: string;
  windowEnd: string;
  scope?: string;
  query?: string;
  limit?: number;
}

/**
 * The persisted, returned unit of captured evidence. `ref` IS the backing
 * `investigation_items.id` (Task 2's `appendEvidenceItem` return value) — the
 * envelope and the stored item are the same fact, viewed two ways; `ref` is
 * how a later hypothesis's `evidence_refs` cites it. `excerpt`/`digest` are
 * computed from the SAME capped, secret-scrubbed text that was persisted as
 * the item's `body` — see `envelope.ts`'s doc-comment for the exact,
 * pinned order.
 */
export interface EvidenceEnvelope {
  ref: string;
  provider: string;
  verb: EvidenceVerb;
  query: EvidenceQuery;
  capturedAt: string;
  excerpt: string;
  digest: string;
  truncated: boolean;
}

/**
 * The closed degradation taxonomy (exact strings, pinned by the spec). Two
 * reasons are ROUTE-level (`no_provider`: nothing declared+credentialed for
 * this verb; `no_investigation`: no anchored artifact to persist evidence
 * against — evidence may not be captured off-artifact). The rest are
 * ADAPTER-level — they describe an adapter's OWN outbound call to its
 * upstream (GitHub/Railway/etc; see `EvidenceAdapter.query`'s return type
 * below), relayed verbatim up through the route to the caller, exactly like
 * `apps/jace/agent/subagents/triage/lib/fetch_run_evidence.core.mjs`'s own
 * `classifyStatus` taxonomy relays HTTP-status-derived reasons — same idea,
 * one layer further out (an adapter's upstream, not the console itself).
 */
export type EvidenceDegradationReason =
  | "config_missing"
  | "no_provider"
  | "no_investigation"
  | "bad_request"
  | "unreachable"
  | "unauthorized"
  | "upstream_error"
  | "unexpected_status"
  | "bad_body";

/** Every {@link EvidenceDegradationReason}, for runtime membership checks. */
export const EVIDENCE_DEGRADATION_REASONS: readonly EvidenceDegradationReason[] = [
  "config_missing",
  "no_provider",
  "no_investigation",
  "bad_request",
  "unreachable",
  "unauthorized",
  "upstream_error",
  "unexpected_status",
  "bad_body",
];

/** A failed evidence request — always `degraded: true` (never a bare `false`/absent flag) so a caller can discriminate this from `{ envelopes }` by presence of the `degraded` key alone. */
export interface EvidenceDegradation {
  degraded: true;
  reason: EvidenceDegradationReason;
}

/**
 * The seam every observability provider implements. This is the ENTIRE
 * surface a new provider needs: a `provider` slug, the verbs it declares, and
 * one `query` method that either succeeds with a raw (unbounded,
 * unscrubbed — the envelope layer handles that) string, or degrades with one
 * of the closed reasons. `secret` is the decrypted per-workspace credential
 * (or `null` for an `availability: "internal"` provider like Task 5's
 * `factory`, which ignores it) — the adapter never touches connector storage
 * itself; the registry/route resolves and hands it in.
 */
export interface EvidenceAdapter {
  provider: string;
  verbs: EvidenceVerb[];
  query(
    workspaceId: string,
    q: EvidenceQuery,
    secret: string | null
  ): Promise<{ ok: true; raw: string } | { ok: false; reason: EvidenceDegradationReason }>;
}
