import type {
  HypothesisState,
  InvestigationAuthority,
  InvestigationSeverity,
  InvestigationStatus,
  InvestigationVerdict,
  VerdictConfidence,
} from "@agentrail/db-postgres";
import {
  AUTHORITY_LABELS,
  CONFIDENCE_LABELS,
  HYPOTHESIS_STATE_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  VERDICT_LABELS,
} from "../investigations-format";

/**
 * Small pill badges for an investigation's facets — 1:1 sibling of
 * `briefs/components/badges.tsx` (see that file's own doc-comment for the
 * shared visual recipe this copies verbatim: `review-gates/page.tsx`'s own
 * `StatusBadge`/`FindingsCountBadge` styling).
 *
 * Every class string below is written out LITERALLY per variant (a
 * `Record<Kind, string>` of full class strings), not assembled at runtime
 * from a shared `${color}` template — Tailwind's build-time scanner only
 * picks up class names that appear as literal text in source (same warning
 * `briefs/components/badges.tsx` gives).
 */
const BASE = "px-1.5 py-0.5 rounded-sm text-xs font-medium";

const SEVERITY_CLASS: Record<InvestigationSeverity, string> = {
  low: `${BASE} bg-[var(--gray-03)] text-[var(--gray-11)]`,
  medium: `${BASE} bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]`,
  high: `${BASE} bg-[color-mix(in_srgb,var(--orange-11)_16%,transparent)] text-[var(--orange-11)]`,
  critical: `${BASE} bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]`,
};

export function SeverityBadge({ severity }: { severity: InvestigationSeverity }) {
  return <span className={SEVERITY_CLASS[severity]}>{SEVERITY_LABELS[severity]}</span>;
}

const STATUS_CLASS: Record<InvestigationStatus, string> = {
  open: `${BASE} bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]`,
  investigating: `${BASE} bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]`,
  concluded: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
  handed_off: `${BASE} bg-[color-mix(in_srgb,var(--purple-11)_16%,transparent)] text-[var(--purple-11)]`,
};

export function StatusBadge({ status }: { status: InvestigationStatus }) {
  return <span className={STATUS_CLASS[status]}>{STATUS_LABELS[status]}</span>;
}

/**
 * `root_caused` green / `undetermined` amber(yellow) / no verdict yet muted
 * — the exact three-way mapping the Task 13 brief pins. `verdict` is the
 * bare denormalized `investigations.verdict` column (null until
 * `recordVerdict` writes one), never re-derived from items here.
 */
const VERDICT_CLASS: Record<InvestigationVerdict, string> = {
  root_caused: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
  undetermined: `${BASE} bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]`,
};
const VERDICT_NONE_CLASS = `${BASE} bg-[var(--gray-03)] text-[var(--gray-09)]`;

export function VerdictBadge({ verdict }: { verdict: InvestigationVerdict | null }) {
  if (!verdict) {
    return <span className={VERDICT_NONE_CLASS}>No verdict yet</span>;
  }
  return <span className={VERDICT_CLASS[verdict]}>{VERDICT_LABELS[verdict]}</span>;
}

const HYPOTHESIS_STATE_CLASS: Record<HypothesisState, string> = {
  open: `${BASE} bg-[var(--gray-03)] text-[var(--gray-11)]`,
  supported: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
  refuted: `${BASE} bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]`,
  inconclusive: `${BASE} bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]`,
};

export function HypothesisStateBadge({ state }: { state: HypothesisState }) {
  return <span className={HYPOTHESIS_STATE_CLASS[state]}>{HYPOTHESIS_STATE_LABELS[state]}</span>;
}

const CONFIDENCE_CLASS: Record<VerdictConfidence, string> = {
  confirmed: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
  probable: `${BASE} bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]`,
  circumstantial: `${BASE} bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]`,
};

export function ConfidenceBadge({ confidence }: { confidence: VerdictConfidence }) {
  return <span className={CONFIDENCE_CLASS[confidence]}>{CONFIDENCE_LABELS[confidence]}</span>;
}

/**
 * `authority` — who asserted this item — mirrors
 * `briefs/components/badges.tsx`'s own `AuthorityBadge` exactly: human gets
 * the brand accent treatment, `jace` stays a plain neutral pill.
 */
const AUTHORITY_CLASS: Record<InvestigationAuthority, string> = {
  human: `${BASE} bg-[color-mix(in_srgb,var(--accent-text)_18%,transparent)] text-[var(--gray-12)]`,
  jace: `${BASE} bg-[var(--gray-03)] text-[var(--gray-11)]`,
};

export function AuthorityBadge({ authority }: { authority: InvestigationAuthority }) {
  return <span className={AUTHORITY_CLASS[authority]}>{AUTHORITY_LABELS[authority]}</span>;
}
