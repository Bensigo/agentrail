import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { computeVerdictEligibility, getInvestigationBySlug } from "@agentrail/db-postgres";
import type {
  InvestigationItem,
  InvestigationItemKind,
  InvestigationVerdict,
  VerdictConfidence,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../../lib/cached";
import { PageHeader } from "../../../../../components/page-header";
import { KIND_LABELS, KIND_ORDER, OPENED_BY_LABELS, formatRelativeTime, groupItemsByKind } from "../investigations-format";
import {
  AuthorityBadge,
  ConfidenceBadge,
  HypothesisStateBadge,
  SeverityBadge,
  StatusBadge,
  VerdictBadge,
} from "../components/badges";
import { ConfirmVerdict } from "../components/confirm-verdict";
import { PromoteLesson } from "../components/promote-lesson";

const ADMIN_ROLES = ["owner", "admin"] as const;

/**
 * Investigation detail page (debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501, Task 13) — the console surface where a human sees EXACTLY what
 * Jace saw for one production incident, confirms a recorded verdict is
 * true, and promotes a drafted lesson into workspace memory. The artifact
 * (`investigations`/`investigation_items`) is the source of truth; this
 * page is a read (plus two narrow, route-gated writes) over it, never a
 * second copy.
 *
 * 1:1 structural sibling of `briefs/[slug]/page.tsx` — server component
 * reading `getInvestigationBySlug` + `computeVerdictEligibility` directly
 * (Budget/Goals/Briefs precedent), `slug` (not the row's uuid) as the URL
 * identity, same plain membership gate.
 *
 * Three things this page keeps visually distinct, deliberately, for the
 * same reason `briefs/[slug]/page.tsx` keeps its own trio distinct:
 * - `status` (badge in the header) — Jace's own lifecycle label
 *   (open/investigating/concluded/handed_off), never a proxy for eligibility.
 * - The eligibility banner — `computeVerdictEligibility`'s own verdict,
 *   RELAYED VERBATIM, never re-derived here (Global Constraints: a model —
 *   or a UI — judging its own evidence sufficiency is exactly the failure
 *   mode the verdict gate exists to close).
 * - `authority` (per-item `AuthorityBadge`) — who asserted THIS item, human
 *   or Jace; not a proxy for either of the above.
 *
 * The ledger renders in the FIXED kind order the Task 13 brief pins
 * (`KIND_ORDER`), every kind present even when empty ("Nothing here yet.") —
 * an empty group is itself signal (mirrors `AREA_ORDER`'s reasoning in
 * `briefs-format.ts`).
 */
export default async function InvestigationDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const found = await getInvestigationBySlug(workspaceId, slug);
  if (!found) return notFound();
  const { investigation, items } = found;

  const eligibility = await computeVerdictEligibility(investigation.id);
  const canManage = ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number]);
  const grouped = groupItemsByKind(items);

  // Resolves an evidence_refs id to a short, human-legible label ("railway ·
  // search_events") instead of a raw uuid — house rule: never a raw id as
  // primary UI text. Falls back to a truncated id (with the full id kept in
  // the chip's `title`) when a ref points at an id this investigation
  // doesn't (or no longer does) have an evidence item for.
  const evidenceById = new Map(items.filter((i) => i.kind === "evidence").map((i) => [i.id, i]));

  const verdictItems = grouped.verdict;
  const latestVerdictId = verdictItems.length > 0 ? verdictItems[verdictItems.length - 1]!.id : null;

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title={investigation.title}
        subtitle={`/${investigation.slug} · opened via ${OPENED_BY_LABELS[investigation.openedBy]}`}
        actions={
          <div className="flex items-center gap-2">
            <SeverityBadge severity={investigation.severity} />
            <StatusBadge status={investigation.status} />
          </div>
        }
      />

      {/* Computed eligibility — DISTINCT from the status badge above.
          record_verdict gates on this, never on `status` (Global
          Constraints: "Verdicts travel only through .../verdict, which runs
          computeVerdictEligibility server-side and fails closed"). */}
      <div
        className={`mb-6 flex items-center gap-2 rounded border p-3 ${
          eligibility.eligible
            ? "border-[var(--gray-05)] bg-[var(--gray-02)]"
            : "border-[var(--red-09)] bg-[color-mix(in_srgb,var(--red-09)_8%,var(--gray-02))]"
        }`}
      >
        {eligibility.eligible ? (
          <p className="text-xs text-[var(--gray-09)]">
            <span className="font-medium text-[var(--green-11)]">Eligible for record_verdict.</span> A
            supported hypothesis with mechanism and evidence, and a refuted rival or a sole-plausible
            finding, are both present.
          </p>
        ) : (
          <>
            <AlertTriangle size={16} className="shrink-0 text-[var(--red-11)]" />
            <p className="text-xs text-[var(--gray-12)]">
              <span className="font-medium text-[var(--red-11)]">Not eligible for record_verdict —</span>{" "}
              {eligibility.blocking.join("; ")}.
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-6">
        {KIND_ORDER.map((kind) => {
          const kindItems = grouped[kind];
          return (
            <section key={kind} className="flex flex-col gap-2">
              <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
                {KIND_LABELS[kind]} ({kindItems.length})
              </h2>
              <div className="flex flex-col gap-2">
                {kindItems.length === 0 && (
                  <p className="text-xs text-[var(--gray-09)]">Nothing here yet.</p>
                )}
                {kindItems.map((item) => (
                  <LedgerItemCard
                    key={item.id}
                    item={item}
                    kind={kind}
                    investigationVerdict={investigation.verdict}
                    isLatestVerdict={item.id === latestVerdictId}
                    evidenceById={evidenceById}
                    workspaceId={workspaceId}
                    slug={investigation.slug}
                    canManage={canManage}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const CARD_CLASSNAME = "rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3";
const CHIP_CLASSNAME = "px-1.5 py-0.5 rounded-sm text-xs font-mono bg-[var(--gray-03)] text-[var(--gray-09)]";

function EvidenceRefChip({
  refId,
  evidenceById,
}: {
  refId: string;
  evidenceById: Map<string, InvestigationItem>;
}) {
  const ev = evidenceById.get(refId);
  const data = (ev?.data ?? {}) as Record<string, unknown>;
  const label = ev
    ? `${typeof data.provider === "string" ? data.provider : "evidence"} · ${
        typeof data.verb === "string" ? data.verb : "?"
      }`
    : `evidence ${refId.slice(0, 8)}`;
  return (
    <span title={refId} className={CHIP_CLASSNAME}>
      {label}
    </span>
  );
}

/**
 * One ledger row, dispatched by `kind` — kept as a single component (rather
 * than five separate files) because the Task 13 file list pins the
 * `components/` directory to exactly `{badges,confirm-verdict,promote-lesson,
 * investigations-format}` — no per-kind card file. Every kind renders
 * `AuthorityBadge` (who asserted this row) since that facet is common to
 * all six kinds, mirroring `BriefItemCard`'s own always-present
 * `AuthorityBadge`.
 */
function LedgerItemCard({
  item,
  kind,
  investigationVerdict,
  isLatestVerdict,
  evidenceById,
  workspaceId,
  slug,
  canManage,
}: {
  item: InvestigationItem;
  kind: InvestigationItemKind;
  investigationVerdict: InvestigationVerdict | null;
  isLatestVerdict: boolean;
  evidenceById: Map<string, InvestigationItem>;
  workspaceId: string;
  slug: string;
  canManage: boolean;
}) {
  const data = (item.data ?? {}) as Record<string, unknown>;
  const timestamp = (
    <span className="text-xs text-[var(--gray-09)]" title={new Date(item.createdAt).toLocaleString()}>
      {formatRelativeTime(item.createdAt)}
    </span>
  );

  if (kind === "evidence") {
    // The human sees exactly what Jace saw: provider/verb/query, then the
    // captured excerpt verbatim in a scrollable, monospace `<pre>` — never
    // re-summarized. `item.body` IS the same capped, secret-scrubbed excerpt
    // `envelope.ts` persisted (Task 4's own doc-comment on the pinned
    // scrub->cap->digest->persist order).
    const query = (data.query ?? {}) as Record<string, unknown>;
    const queryText = typeof query.query === "string" && query.query ? query.query : null;
    const scope = typeof query.scope === "string" && query.scope ? query.scope : null;
    return (
      <div className={CARD_CLASSNAME}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className={CHIP_CLASSNAME}>{typeof data.provider === "string" ? data.provider : "unknown"}</span>
          <span className={CHIP_CLASSNAME}>{typeof data.verb === "string" ? data.verb : "unknown"}</span>
          {queryText && <span className="font-mono text-xs text-[var(--gray-09)]">&ldquo;{queryText}&rdquo;</span>}
          {scope && <span className="font-mono text-xs text-[var(--gray-09)]">scope: {scope}</span>}
          {data.truncated === true && (
            <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] text-[var(--yellow-11)]">
              truncated
            </span>
          )}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-2 font-mono text-xs text-[var(--gray-12)]">
          {item.body}
        </pre>
        <div className="mt-1.5 flex items-center gap-2">
          <AuthorityBadge authority={item.authority} />
          {timestamp}
        </div>
      </div>
    );
  }

  if (kind === "hypothesis") {
    return (
      <div className={CARD_CLASSNAME}>
        <p className="text-sm text-[var(--gray-12)]">{item.body}</p>
        {item.mechanism && <p className="mt-1 text-xs text-[var(--gray-09)]">Mechanism: {item.mechanism}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.state && <HypothesisStateBadge state={item.state} />}
          <AuthorityBadge authority={item.authority} />
          {item.evidenceRefs.map((ref) => (
            <EvidenceRefChip key={ref} refId={ref} evidenceById={evidenceById} />
          ))}
          {timestamp}
        </div>
      </div>
    );
  }

  if (kind === "finding") {
    const solePlausible = data.solePlausible === true;
    return (
      <div className={CARD_CLASSNAME}>
        <p className="text-sm text-[var(--gray-12)]">{item.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <AuthorityBadge authority={item.authority} />
          {solePlausible && (
            <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--blue-11)_16%,transparent)] text-[var(--blue-11)]">
              Sole plausible
            </span>
          )}
          {item.evidenceRefs.map((ref) => (
            <EvidenceRefChip key={ref} refId={ref} evidenceById={evidenceById} />
          ))}
          {timestamp}
        </div>
      </div>
    );
  }

  if (kind === "verdict") {
    // A verdict ITEM's own `data` only ever carries confidence +
    // missingEvidence (recordVerdict's own doc-comment) — never a
    // per-item `verdict` value. Only the investigation row's denormalized
    // `verdict` reflects the LATEST recorded call, so only the latest
    // item can honestly show a verdict pill; an older, superseded item is
    // labeled as historical rather than guessing its type from
    // confidence/missingEvidence alone.
    const confidence = (data.confidence ?? null) as VerdictConfidence | null;
    const missingEvidence = Array.isArray(data.missingEvidence) ? (data.missingEvidence as string[]) : [];
    const humanConfirmed = data.humanConfirmed === true;
    return (
      <div className={CARD_CLASSNAME}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {isLatestVerdict ? (
                <VerdictBadge verdict={investigationVerdict} />
              ) : (
                <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--gray-03)] text-[var(--gray-09)]">
                  Earlier verdict
                </span>
              )}
              {confidence && <ConfidenceBadge confidence={confidence} />}
              <AuthorityBadge authority={item.authority} />
            </div>
            {item.body && <p className="mt-1.5 text-sm text-[var(--gray-12)]">{item.body}</p>}
            {missingEvidence.length > 0 && (
              <p className="mt-1.5 text-xs text-[var(--gray-09)]">Missing: {missingEvidence.join("; ")}</p>
            )}
            <p className="mt-1.5" title={new Date(item.createdAt).toLocaleString()}>
              <span className="text-xs text-[var(--gray-09)]">recorded {formatRelativeTime(item.createdAt)}</span>
            </p>
          </div>
          {isLatestVerdict && (
            <ConfirmVerdict workspaceId={workspaceId} slug={slug} confirmed={humanConfirmed} canManage={canManage} />
          )}
        </div>
      </div>
    );
  }

  if (kind === "lesson_candidate") {
    const promotedAt = typeof data.promotedAt === "string" ? data.promotedAt : null;
    return (
      <div className={CARD_CLASSNAME}>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm text-[var(--gray-12)]">{item.body}</p>
          <PromoteLesson
            workspaceId={workspaceId}
            slug={slug}
            itemId={item.id}
            promoted={!!promotedAt}
            canManage={canManage}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <AuthorityBadge authority={item.authority} />
          {promotedAt && (
            <span className="text-xs text-[var(--gray-09)]" title={new Date(promotedAt).toLocaleString()}>
              promoted {formatRelativeTime(promotedAt)}
            </span>
          )}
          {!promotedAt && timestamp}
        </div>
      </div>
    );
  }

  // timeline_event — free-form witness-interview / round-report notes.
  return (
    <div className={CARD_CLASSNAME}>
      <p className="text-sm text-[var(--gray-12)]">{item.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <AuthorityBadge authority={item.authority} />
        {timestamp}
      </div>
    </div>
  );
}
