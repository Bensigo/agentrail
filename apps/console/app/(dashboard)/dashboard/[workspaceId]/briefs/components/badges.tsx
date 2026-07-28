import type { BriefAuthority, BriefItemKind, BriefItemResolution, BriefItemState } from "@agentrail/db-postgres";
import {
  AUTHORITY_LABELS,
  KIND_LABELS,
  RESOLUTION_LABELS,
  STATE_LABELS,
} from "../briefs-format";

/**
 * Small pill badges for a brief item's four facets. Same visual recipe as
 * the review-gates page's own `StatusBadge`/`FindingsCountBadge`
 * (`review-gates/page.tsx`): `bg-[color-mix(in_srgb,var(--COLOR-11)_16%,transparent)]
 * text-[var(--COLOR-11)]`, `px-1.5 py-0.5 rounded-sm text-xs font-medium`.
 *
 * Every class string below is written out LITERALLY per variant (a
 * `Record<Kind, string>` of full class strings, exactly like
 * `review-gates/page.tsx`'s own `StatusBadge` styles map), not assembled at
 * runtime from a shared `${color}` template — Tailwind's build-time scanner
 * only picks up class names that appear as literal text in source, so a
 * dynamically-interpolated `var(${color})` would silently never get
 * generated into the compiled CSS.
 */
const BASE = "px-1.5 py-0.5 rounded-sm text-xs font-medium";

const KIND_CLASS: Record<BriefItemKind, string> = {
  required: `${BASE} bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]`,
  optional: `${BASE} bg-[color-mix(in_srgb,var(--gray-11)_16%,transparent)] text-[var(--gray-11)]`,
  // Unknown is the one kind that can BLOCK to-issues while open — it gets
  // the same red weight as review-gates' "failed" badge, not an incidental
  // color choice.
  unknown: `${BASE} bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]`,
  "out-of-scope": `${BASE} bg-[color-mix(in_srgb,var(--gray-09)_16%,transparent)] text-[var(--gray-09)]`,
};

export function KindBadge({ kind }: { kind: BriefItemKind }) {
  return <span className={KIND_CLASS[kind]}>{KIND_LABELS[kind]}</span>;
}

const STATE_CLASS: Record<BriefItemState, string> = {
  open: `${BASE} bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]`,
  resolved: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
};

export function StateBadge({ state }: { state: BriefItemState }) {
  return <span className={STATE_CLASS[state]}>{STATE_LABELS[state]}</span>;
}

const RESOLUTION_CLASS: Record<BriefItemResolution, string> = {
  implemented: `${BASE} bg-[color-mix(in_srgb,var(--green-11)_16%,transparent)] text-[var(--green-11)]`,
  deferred: `${BASE} bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]`,
  rejected: `${BASE} bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]`,
  "satisfied-elsewhere": `${BASE} bg-[color-mix(in_srgb,var(--teal-11)_16%,transparent)] text-[var(--teal-11)]`,
};

export function ResolutionBadge({ resolution }: { resolution: BriefItemResolution }) {
  return <span className={RESOLUTION_CLASS[resolution]}>{RESOLUTION_LABELS[resolution]}</span>;
}

/**
 * `authority` — "who asserted this item" — is the one facet the design spec
 * calls out as needing to be visible "at a glance" (this feature's own
 * brief: "A human needs to see at a glance which statements are their own
 * words versus Jace's inference"). Human gets the brand accent treatment
 * (this IS the human's own correction, the whole point of this page);
 * `jace` stays a plain neutral pill — no drama for the common case.
 */
const AUTHORITY_CLASS: Record<BriefAuthority, string> = {
  human: `${BASE} bg-[color-mix(in_srgb,var(--accent-text)_18%,transparent)] text-[var(--gray-12)]`,
  jace: `${BASE} bg-[var(--gray-03)] text-[var(--gray-11)]`,
};

export function AuthorityBadge({ authority }: { authority: BriefAuthority }) {
  return <span className={AUTHORITY_CLASS[authority]}>{AUTHORITY_LABELS[authority]}</span>;
}
