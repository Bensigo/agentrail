"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StatHeader } from "../../../../components/stat-header";
import { EmptyState } from "../../../../components/empty-state";
import { ErrorState } from "../../../../components/error-state";
import { LoadingState } from "../../../../components/loading-state";
import { WikiNavTree } from "./wiki-nav-tree";
import { WikiPageView, type LatestCompileDTO } from "./wiki-page-view";
import { WikiRepoList } from "./wiki-repo-list";
import { RecompileButton } from "./recompile-button";
import {
  computeWikiSummaryStats,
  formatRelativeAge,
  groupWikiPages,
  healthStatColor,
  type RepoListItem,
  type WikiPageDTO,
} from "../wiki-format";

interface WikiApiResponse {
  repos: RepoListItem[];
  canManage: boolean;
  selectedRepoId: string | null;
  repoUrl: string | null;
  pages: WikiPageDTO[] | null;
  latestCompile: LatestCompileDTO | null;
}

export function WikiClient({ workspaceId }: { workspaceId: string }) {
  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [canManage, setCanManage] = useState(false);
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
        setCanManage(json.canManage);
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
  const selectedRepo = repoId ? repos.find((r) => r.id === repoId) ?? null : null;

  const stats = useMemo(() => {
    if (!pages) return [];
    const s = computeWikiSummaryStats(pages);
    type Stat = {
      label: string;
      value: string | number;
      color?: "green" | "red" | "orange" | "yellow" | "gray";
    };
    const items: Stat[] = [
      { label: "Pages", value: s.pageCount },
      {
        label: "Stale",
        value: s.staleCount,
        color: s.staleCount > 0 ? "yellow" : "gray",
      },
      {
        label: "Oldest page",
        value: s.oldestGeneratedAt ? formatRelativeAge(s.oldestGeneratedAt) : "—",
      },
    ];
    // Wiki freshness (above) and index freshness (below) are different
    // facts — labeled distinctly rather than folded into one stat.
    if (selectedRepo) {
      items.push({
        label: "Last indexed",
        value: selectedRepo.lastIndexedAt ? formatRelativeAge(selectedRepo.lastIndexedAt) : "never",
        color: healthStatColor(selectedRepo.healthStatus),
      });
    }
    return items;
  }, [pages, selectedRepo]);

  function handleRepoAdded(repo: RepoListItem) {
    setRepos((prev) => [repo, ...prev]);
  }

  if (loading) {
    return <LoadingState variant="list" rows={6} />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => load(repoId)} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <WikiRepoList
        workspaceId={workspaceId}
        repos={repos}
        selectedId={repoId}
        canManage={canManage}
        onSelect={(id) => load(id)}
        onAdded={handleRepoAdded}
      />

      {repos.length === 0 ? null : repoId === null ? (
        <EmptyState message="Select a repository above to view its wiki." />
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
                  key={selectedPage.slug}
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
