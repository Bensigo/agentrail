import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { computeBriefReadiness, listBriefs } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { PageHeader } from "../../../../components/page-header";
import { EmptyState } from "../../../../components/empty-state";
import { formatRelativeTime } from "./briefs-format";

/**
 * Workspace Briefs index (spec PR #1487/#1489, docs/superpowers/specs/
 * 2026-07-28-jace-briefs-durable-idea-understanding-design.md): the list of
 * every product idea Jace has a durable understanding of for this workspace.
 * A server component reading `listBriefs` directly (Budget/Goals-page
 * precedent: "no client fetch, no new API route" for a read-only view).
 *
 * `listBriefs` deliberately excludes items (see its own doc-comment: a
 * workspace-wide list never needs a full N-brief × M-item join), so
 * readiness is computed here with one `computeBriefReadiness` call per row
 * — the same computed-vs-label distinction the detail page draws is drawn
 * here too, just as a compact "blocked" flag rather than the full banner.
 *
 * Auth mirrors every sibling workspace page (plain membership gate; the
 * workspace layout already guards session + membership, this re-checks
 * defensively — see `goals/page.tsx`'s own doc-comment for the precedent).
 */
export default async function BriefsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  const session = await getSession();
  if (!session?.user?.id) return notFound();

  const membership = await getMembership(session.user.id, workspaceId);
  if (!membership) return notFound();

  const briefs = await listBriefs(workspaceId);
  const readiness = await Promise.all(briefs.map((brief) => computeBriefReadiness(brief.id)));

  if (briefs.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px]">
        <PageHeader
          title="Briefs"
          subtitle="Shape work before it becomes an Acceptance Record."
        />
        <EmptyState
          icon={FileText}
          title="No briefs yet"
          description="Create a Brief from a conversation with Jace."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Briefs"
        subtitle="Shape work before it becomes an Acceptance Record."
      />
      <div className="flex flex-col gap-2">
        {briefs.map((brief, i) => {
          const ready = readiness[i]!;
          return (
            <Link
              key={brief.id}
              href={`/dashboard/${workspaceId}/briefs/${brief.slug}`}
              className="flex items-center justify-between gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-4 py-3 transition-colors hover:border-[var(--gray-08)]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--gray-12)]">{brief.title}</p>
                {/* Slug, not the row's uuid, is the visible secondary identity
                    (house rule: names/slugs over raw ids). */}
                <p className="font-mono text-xs text-[var(--gray-09)]">/{brief.slug}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {!ready.ready && (
                  <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[color-mix(in_srgb,var(--red-11)_16%,transparent)] text-[var(--red-11)]">
                    {ready.blockingItems.length} unresolved
                  </span>
                )}
                <span className="px-1.5 py-0.5 rounded-sm text-xs font-medium capitalize bg-[var(--gray-03)] text-[var(--gray-11)]">
                  {brief.status}
                </span>
                <span className="text-xs text-[var(--gray-09)]" title={new Date(brief.updatedAt).toLocaleString()}>
                  {formatRelativeTime(brief.updatedAt)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
