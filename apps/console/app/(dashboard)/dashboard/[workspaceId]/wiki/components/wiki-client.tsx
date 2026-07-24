"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StatHeader } from "../../../../components/stat-header";
import { EmptyState } from "../../../../components/empty-state";
import { ErrorState } from "../../../../components/error-state";
import { LoadingState } from "../../../../components/loading-state";
import { WikiNavTree } from "./wiki-nav-tree";
import { WikiPageView, type LatestCompileDTO } from "./wiki-page-view";
import { RecompileButton } from "./recompile-button";
import {
  computeWikiSummaryStats,
  formatRelativeAge,
  groupWikiPages,
  type WikiPageDTO,
} from "../wiki-format";

interface RepoOption {
  id: string;
  name: string;
}

interface WikiApiResponse {
  repos: RepoOption[];
  selectedRepoId: string | null;
  repoUrl: string | null;
  pages: WikiPageDTO[] | null;
  latestCompile: LatestCompileDTO | null;
}

export function WikiClient({ workspaceId }: { workspaceId: string }) {
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [pages, setPages] = useState<WikiPageDTO[] | null>(null);
  const [latestCompile, setLatestCompile] = useState<LatestCompileDTO | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (targetRepoId: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const url = targetRepoId
          ? `/api/v1/workspaces/${workspaceId}/wiki?repoId=${encodeURIComponent(targetRepoId)}`
          : `/api/v1/workspaces/${workspaceId}/wiki`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        const json = (await res.json()) as WikiApiResponse;
        setRepos(json.repos);
        setRepoId(json.selectedRepoId);
        setRepoUrl(json.repoUrl);
        setPages(json.pages);
        setLatestCompile(json.latestCompile);
        setSelectedSlug((prev) => {
          if (!json.pages || json.pages.length === 0) return null;
          if (prev && json.pages.some((p) => p.slug === prev)) return prev;
          // Overview always sorts first when present (listWikiPages' ORDER BY
          // slug); otherwise the first unit page.
          return json.pages[0]!.slug;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load the wiki");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const { overview, units } = useMemo(() => groupWikiPages(pages ?? []), [pages]);
  const pagesBySlug = useMemo(
    () => new Map((pages ?? []).map((p) => [p.slug, p])),
    [pages]
  );
  const selectedPage = selectedSlug ? pagesBySlug.get(selectedSlug) ?? null : null;

  const stats = useMemo(() => {
    if (!pages) return [];
    const s = computeWikiSummaryStats(pages);
    return [
      { label: "Pages", value: s.pageCount },
      {
        label: "Stale",
        value: s.staleCount,
        color: s.staleCount > 0 ? ("yellow" as const) : ("gray" as const),
      },
      {
        label: "Oldest page",
        value: s.oldestGeneratedAt ? formatRelativeAge(s.oldestGeneratedAt) : "—",
      },
    ];
  }, [pages]);

  if (loading) {
    return <LoadingState variant="list" rows={6} />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => load(repoId)} />;
  }

  if (repos.length === 0) {
    return (
      <EmptyState
        message="No repositories connected yet."
        action={
          <Link
            href={`/dashboard/${workspaceId}/repos`}
            className="text-sm text-[var(--blue-11)] hover:underline"
          >
            Add your first repository →
          </Link>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <RepoPicker repos={repos} selectedId={repoId} onChange={(id) => load(id)} />

      {repoId === null ? (
        <EmptyState message="Select a repository to view its wiki." />
      ) : pages === null || pages.length === 0 ? (
        <EmptyState
          message="No wiki compiled yet for this repository."
          action={<RecompileButton variant="button" />}
        />
      ) : (
        <>
          <StatHeader stats={stats} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
            <div className="lg:border-r lg:border-[var(--gray-05)] lg:pr-4">
              <WikiNavTree
                overview={overview}
                units={units}
                selectedSlug={selectedSlug}
                onSelectSlug={setSelectedSlug}
              />
            </div>
            <div className="min-w-0">
              {selectedPage && (
                <WikiPageView
                  page={selectedPage}
                  repoUrl={repoUrl}
                  latestCompile={latestCompile}
                  pagesBySlug={pagesBySlug}
                  onSelectSlug={setSelectedSlug}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Single-repo workspaces auto-select and never see a picker (spec §4.5,
 * TASTE.md "prefer fewer, clearer states") — just the repo name for
 * orientation. Multi-repo workspaces get a plain `<select>` (TASTE.md Inputs).
 */
function RepoPicker({
  repos,
  selectedId,
  onChange,
}: {
  repos: RepoOption[];
  selectedId: string | null;
  onChange: (id: string) => void;
}) {
  if (repos.length === 1) {
    return <p className="font-mono text-xs text-[var(--gray-09)]">{repos[0]!.name}</p>;
  }

  return (
    <select
      value={selectedId ?? ""}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Repository"
      className="h-8 w-fit rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 text-sm text-[var(--gray-12)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
    >
      <option value="" disabled>
        Select a repository…
      </option>
      {repos.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}
