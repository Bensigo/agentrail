import { notFound } from "next/navigation";
import { AlertTriangle, CircleHelp } from "lucide-react";
import { computeBriefReadiness, getBriefBySlug, readAcceptanceBriefBinding, type AcceptanceBriefBindingRead } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../../lib/cached";
import { PageHeader } from "../../../../../components/page-header";
import { AREA_LABELS, AREA_ORDER, groupItemsByArea, isBlockingItem } from "../briefs-format";
import { BriefItemCard } from "../components/brief-item-card";
import { BriefStatusToggle } from "../components/brief-status-toggle";
import { NewBriefItemForm } from "../components/new-brief-item-form";

const ADMIN_ROLES = ["owner", "admin"] as const;

export function AcceptanceBriefTransitionPanel({
  workspaceId,
  bindings,
}: {
  workspaceId: string;
  bindings: AcceptanceBriefBindingRead[];
}) {
  const hasBindings = bindings.length > 0;
  return (
    <section className="mb-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="border-b border-[var(--gray-05)] px-4 py-3">
        <h2 className="text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">
          Brief transition
        </h2>
      </div>
      <div className="flex flex-col gap-2 px-4 py-4 text-xs text-[var(--gray-09)]">
        {!hasBindings ? (
          <p>This editable Brief is still shaping work and no Acceptance Record is linked.</p>
        ) : (
          <>
            <p>This Brief transitioned into Acceptance Records.</p>
            <p>The transition captured immutable Brief provenance.</p>
            <ol className="flex list-decimal flex-col gap-1 pl-4">
              {bindings.map((binding, index) => (
                <li key={binding.record.id}>
                  <a
                    href={`/dashboard/${encodeURIComponent(workspaceId)}/changes/${binding.record.id}`}
                    className="text-[var(--blue-11)] hover:underline"
                  >
                    Acceptance Record
                  </a>
                  <span className="ml-1 text-[var(--gray-08)]">#{index + 1}</span>
                </li>
              ))}
            </ol>
            <p>
              The Brief stays editable, but later edits cannot rewrite any linked Acceptance
              Record&apos;s Contract, Context Pack, review evidence, or final decision.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Brief detail page (spec PR #1487/#1489) — the console surface where a
 * human reads and CORRECTS what Jace understood about one product idea.
 * This is the whole point of putting a brief in the product rather than the
 * user's repo: without this page the authority model (`authority: 'human'`
 * locks a row against Jace's own writes) is untested, and the only way to
 * fix a misunderstanding is to re-explain it in chat — precisely the bug
 * this feature exists to close.
 *
 * A server component reading `getBriefBySlug` + `computeBriefReadiness`
 * directly (Budget/Goals-page precedent). `slug`, not the row's uuid, is the
 * URL identity — the design spec's own framing of slug as a brief's stable,
 * human-renameable identity, and consistent with "never show a raw UUID as
 * primary UI text".
 *
 * Three things this page keeps visually distinct, deliberately, because
 * conflating any pair of them is exactly the bug the design spec warns
 * against:
 * - `status` (`BriefStatusToggle`) — a HUMAN label, toggled here, that
 *   `to-issues` must NEVER read.
 * - Computed readiness (the banner below) — `computeBriefReadiness`'s own
 *   `open` + `kind: unknown` check, the thing `to-issues` actually gates on.
 * - `authority` (per-item `AuthorityBadge`) — who asserted THIS item, human
 *   or Jace; not a proxy for either of the above.
 */
export default async function BriefDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; slug: string }>;
}) {
  const { workspaceId, slug } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const brief = await getBriefBySlug(workspaceId, slug);
  if (!brief) return notFound();

  const briefBindingRows = await readAcceptanceBriefBinding({ workspaceId, briefId: brief.id });
  const briefBindings = Array.isArray(briefBindingRows)
    ? briefBindingRows
    : briefBindingRows
      ? [briefBindingRows]
      : [];
  const readiness = await computeBriefReadiness(brief.id);
  const canManage = ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number]);
  const grouped = groupItemsByArea(brief.items);
  const blockingIds = new Set(readiness.blockingItems.map((i) => i.id));

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title={brief.title}
        subtitle={`/${brief.slug}`}
        actions={
          <BriefStatusToggle
            workspaceId={workspaceId}
            slug={brief.slug}
            status={brief.status}
            canManage={canManage}
          />
        }
      />

      <AcceptanceBriefTransitionPanel workspaceId={workspaceId} bindings={briefBindings} />

      {brief.openQuestion && (
        <div className="mb-4 flex items-start gap-2 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3">
          <CircleHelp size={16} className="mt-0.5 shrink-0 text-[var(--blue-11)]" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
              In-flight question
            </p>
            <p className="mt-0.5 text-sm text-[var(--gray-12)]">{brief.openQuestion}</p>
          </div>
        </div>
      )}

      {/* Computed readiness — DISTINCT from the draft/ready label above.
          `to-issues` gates on this, never on `status` (design spec,
          "Readiness gate"). */}
      <div
        className={`mb-6 flex items-center gap-2 rounded border p-3 ${
          readiness.ready
            ? "border-[var(--gray-05)] bg-[var(--gray-02)]"
            : "border-[var(--red-09)] bg-[color-mix(in_srgb,var(--red-09)_8%,var(--gray-02))]"
        }`}
      >
        {readiness.ready ? (
          <p className="text-xs text-[var(--gray-09)]">
            <span className="font-medium text-[var(--green-11)]">Ready for to-issues.</span> No
            open item is still an unknown.
          </p>
        ) : (
          <>
            <AlertTriangle size={16} className="shrink-0 text-[var(--red-11)]" />
            <p className="text-xs text-[var(--gray-12)]">
              <span className="font-medium text-[var(--red-11)]">
                Blocks to-issues — {readiness.blockingItems.length} open item
                {readiness.blockingItems.length === 1 ? "" : "s"} still {" "}
                <span className="underline decoration-dotted">unknown</span>.
              </span>{" "}
              Answer each one (change its kind to required/optional) or mark it out-of-scope —
              deleting is the only other way to clear it.
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-6">
        {AREA_ORDER.map((area) => {
          const items = grouped[area];
          return (
            <section key={area} className="flex flex-col gap-2">
              <h2 className="text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
                {AREA_LABELS[area]} ({items.length})
              </h2>
              <div className="flex flex-col gap-2">
                {items.length === 0 && (
                  <p className="text-xs text-[var(--gray-09)]">Nothing settled here yet.</p>
                )}
                {items.map((item) => (
                  <BriefItemCard
                    key={item.id}
                    item={item}
                    workspaceId={workspaceId}
                    slug={brief.slug}
                    canManage={canManage}
                    blocking={blockingIds.has(item.id) || isBlockingItem(item)}
                  />
                ))}
                {canManage && (
                  <NewBriefItemForm workspaceId={workspaceId} slug={brief.slug} area={area} />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
