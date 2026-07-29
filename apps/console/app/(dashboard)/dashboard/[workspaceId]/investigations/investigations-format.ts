import type {
  HypothesisState,
  InvestigationAuthority,
  InvestigationItem,
  InvestigationItemKind,
  InvestigationOpenedBy,
  InvestigationSeverity,
  InvestigationStatus,
  InvestigationVerdict,
  VerdictConfidence,
} from "@agentrail/db-postgres";

/**
 * Pure formatting/grouping helpers for the console Investigations pages
 * (debugging design spec: docs/superpowers/specs/2026-07-29-jace-debugging-
 * agent-design.md, spec PR #1501; `.superpowers/sdd/spec.md` is the working
 * copy Task 13 follows). 1:1 sibling of `briefs/briefs-format.ts` — kept
 * dependency-free (no React) for the same reason that file is: plain vitest,
 * no DOM/render harness needed.
 */

/**
 * Canonical ledger order (Task 13 brief: "ledger grouped by kind in order
 * timeline_event, evidence, hypothesis, finding, verdict, lesson_candidate").
 * Fixed, not derived from whatever items happen to exist — same reasoning as
 * `briefs-format.ts`'s `AREA_ORDER`: an investigation with nothing yet in,
 * say, `lesson_candidate` still SHOWS that section as empty, because the gap
 * itself ("Jace hasn't drafted a lesson from this yet") is signal.
 */
export const KIND_ORDER: InvestigationItemKind[] = [
  "timeline_event",
  "evidence",
  "hypothesis",
  "finding",
  "verdict",
  "lesson_candidate",
];

export const KIND_LABELS: Record<InvestigationItemKind, string> = {
  timeline_event: "Timeline",
  evidence: "Evidence",
  hypothesis: "Hypotheses",
  finding: "Findings",
  verdict: "Verdict",
  lesson_candidate: "Lesson candidates",
};

export const SEVERITY_LABELS: Record<InvestigationSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const STATUS_LABELS: Record<InvestigationStatus, string> = {
  open: "Open",
  investigating: "Investigating",
  concluded: "Concluded",
  handed_off: "Handed off",
};

export const OPENED_BY_LABELS: Record<InvestigationOpenedBy, string> = {
  chat: "chat",
  "run-outcome": "a run outcome",
  alert: "an alert",
};

export const VERDICT_LABELS: Record<InvestigationVerdict, string> = {
  root_caused: "Root caused",
  undetermined: "Undetermined",
};

export const CONFIDENCE_LABELS: Record<VerdictConfidence, string> = {
  confirmed: "Confirmed",
  probable: "Probable",
  circumstantial: "Circumstantial",
};

export const HYPOTHESIS_STATE_LABELS: Record<HypothesisState, string> = {
  open: "Open",
  supported: "Supported",
  refuted: "Refuted",
  inconclusive: "Inconclusive",
};

export const AUTHORITY_LABELS: Record<InvestigationAuthority, string> = {
  human: "Human",
  jace: "Jace",
};

/**
 * Every item for `kind`, in the fixed `KIND_ORDER` — every kind is present
 * as a key even with zero items (see `KIND_ORDER`'s own doc-comment for
 * why an empty group must still render, mirroring `groupItemsByArea` in
 * `briefs-format.ts`). Items within a kind keep whatever order the caller
 * passed in — the store layer already orders by `createdAt` ascending
 * (`fetchItemsForInvestigation`'s own doc-comment), so the ledger reads in
 * the order events actually happened.
 */
export function groupItemsByKind(
  items: InvestigationItem[]
): Record<InvestigationItemKind, InvestigationItem[]> {
  const grouped = Object.fromEntries(KIND_ORDER.map((kind) => [kind, [] as InvestigationItem[]])) as Record<
    InvestigationItemKind,
    InvestigationItem[]
  >;
  for (const item of items) {
    grouped[item.kind]?.push(item);
  }
  return grouped;
}

/**
 * The index page's red "N open hypotheses" count — exactly the formula the
 * Task 13 brief pins: `state === "open" && kind === "hypothesis"`. Distinct
 * from `computeVerdictEligibility`'s `blocking` array (that reports WHY the
 * verdict gate is closed, in prose; this counts open threads, a cheap
 * at-a-glance "how much is still unresolved here" signal for the list view).
 */
export function countOpenHypotheses(items: Pick<InvestigationItem, "kind" | "state">[]): number {
  return items.filter((item) => item.kind === "hypothesis" && item.state === "open").length;
}

/** `YYYY-MM-DDTHH:mm`-ish absolute stamp for a hover title — matches `briefs-format.ts`'s own `formatAbsoluteTime`. */
export function formatAbsoluteTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString();
}

/** Compact relative time ("3m ago", "2d ago") — duplicated from `briefs-format.ts`'s own copy rather than imported, same sibling-feature reasoning that file gives for its own duplication from review-gates. */
export function formatRelativeTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60000);
  const h = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${days}d ago`;
}
