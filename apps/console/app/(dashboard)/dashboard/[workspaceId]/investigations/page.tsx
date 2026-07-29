import Link from "next/link";
import { notFound } from "next/navigation";
import { SearchCode } from "lucide-react";
import { computeVerdictEligibility, getInvestigationById, listInvestigations } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { EmptyState } from "../../../../components/empty-state";
import { EligibilityBadge, SeverityBadge, StatusBadge, VerdictBadge } from "./components/badges";
import { countOpenHypotheses, formatRelativeTime } from "./investigations-format";

/**
 * Workspace Investigations index (debugging design spec:
 * docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md, spec PR
 * #1501, Task 13): the list of every production incident Jace has a durable
 * record of for this workspace. A server component reading `listInvestigations`
 * directly — same "no client fetch, no new API route" posture as the sibling
 * Briefs index (`briefs/page.tsx`'s own doc-comment).
 *
 * `listInvestigations` deliberately excludes items (mirrors `listBriefs`: a
 * workspace-wide list never needs a full N-investigation × M-item join), so
 * this page fetches the two per-row supplements the row actually needs, one
 * `Promise.all` per investigation, mirroring the briefs index's own
 * `computeBriefReadiness`-per-row shape:
 *   - `computeVerdictEligibility` — the SAME server-computed gate the detail
 *     page's banner reads, never re-derived here. EVERY row renders its own
 *     always-present `EligibilityBadge` from this (green "Eligible" / amber
 *     "Not eligible", Fix round 1 — the original cut only surfaced this as
 *     the open-hypotheses badge's tooltip, which meant a row with ZERO open
 *     hypotheses but still no refuted rival/solePlausible finding showed no
 *     eligibility signal at all). The blocking reasons ALSO still feed the
 *     open-hypotheses badge's own tooltip below, unchanged — the two badges
 *     answer related but distinct questions ("can a verdict be recorded
 *     right now" vs "how many open threads are there").
 *   - `getInvestigationById` — items, to compute the red "N open hypotheses"
 *     count (`state === "open" && kind === "hypothesis"`, pinned by the Task
 *     13 brief) via the pure `countOpenHypotheses` helper.
 *
 * Auth mirrors every sibling workspace page (plain membership gate; the
 * workspace layout already guards session + membership, this re-checks
 * defensively — see `briefs/page.tsx`'s own doc-comment for the precedent).
 */
export default async function InvestigationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const investigations = await listInvestigations(workspaceId);

  if (investigations.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <PageHeader
          title="Investigations"
          subtitle="Jace's durable record of production incidents — the ledger a human confirms verdicts and promotes lessons from."
        />
        <EmptyState
          icon={SearchCode}
          title="No investigations yet"
          description="An investigation starts when Jace opens one from a production symptom — it becomes the durable record of what was found, and the human gate before a verdict counts."
        />
      </div>
    );
  }

  const rows = await Promise.all(
    investigations.map(async (investigation) => {
      const [eligibility, withItems] = await Promise.all([
        computeVerdictEligibility(investigation.id),
        getInvestigationById(investigation.id),
      ]);
      return {
        investigation,
        eligibility,
        openHypotheses: countOpenHypotheses(withItems?.items ?? []),
      };
    })
  );

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Investigations"
        subtitle="Jace's durable record of production incidents — the ledger a human confirms verdicts and promotes lessons from."
      />
      <div className="flex flex-col gap-2">
        {rows.map(({ investigation, eligibility, openHypotheses }) => (
          <Link
            key={investigation.id}
            href={`/dashboard/${workspaceId}/investigations/${investigation.slug}`}
            className="flex items-center justify-between gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3 transition-colors hover:border-[var(--gray-08)]"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--gray-12)]">{investigation.title}</p>
              {/* Slug, not the row's uuid, is the visible secondary identity
                  (house rule: names/slugs over raw ids). */}
              <p className="font-mono text-xs text-[var(--gray-09)]">/{investigation.slug}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <EligibilityBadge eligibility={eligibility} />
              {openHypotheses > 0 && (
                <span
                  title={!eligibility.eligible ? eligibility.blocking.join("; ") : undefined}
                  className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]"
                >
                  {openHypotheses} open hypothes{openHypotheses === 1 ? "is" : "es"}
                </span>
              )}
              <SeverityBadge severity={investigation.severity} />
              <StatusBadge status={investigation.status} />
              <VerdictBadge verdict={investigation.verdict} />
              <span
                className="text-xs text-[var(--gray-09)]"
                title={new Date(investigation.updatedAt).toLocaleString()}
              >
                {formatRelativeTime(investigation.updatedAt)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
