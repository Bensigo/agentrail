"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "../../../../components/empty-state";
import { ErrorState } from "../../../../components/error-state";
import { LoadingState } from "../../../../components/loading-state";
import { WikiNavTree } from "./wiki-nav-tree";
import { WikiPageView, type LatestCompileDTO } from "./wiki-page-view";
import { WikiRepoHeader } from "./wiki-repo-header";
import { RecompileButton } from "./recompile-button";
import {
  computeWikiSummaryStats,
  groupWikiPages,
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
  // Distinct from `loading`: `loading` toggles on every fetch, including a
  // repo switch — but the header/picker must stay mounted across a switch
  // (spec: the wiki owns the viewport, the header is persistent chrome), so
  // only the FIRST load (nothing rendered yet at all) gets the full-page
  // skeleton. Later loads skeleton just the body, gated on `loading` alone
  // further down.
  const [initialized, setInitialized] = useState(false);
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
        setInitialized(true);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  // A multi-repo workspace's initial fetch (no `?repoId=`) only ever returns
  // the repo list — the API auto-selects a repo itself just for the
  // single-repo case. Auto-select the first repo client-side too, so a
  // multi-repo workspace lands on an actual wiki instead of an empty "pick
  // one" step (owner feedback: the page must read as the wiki, not a repo
  // chooser). The user can still switch via `WikiRepoHeader`'s picker.
  // `repos.length > 0` (not `> 1`): this also covers connecting the very
  // FIRST repo from the empty state — `handleRepoAdded` splices it into
  // local state without a re-fetch, so `repoId` stays null there too, and
  // without this the body would skeleton forever with nothing to trigger a
  // load.
  useEffect(() => {
    if (!loading && repoId === null && repos.length > 0) {
      load(repos[0]!.id);
    }
  }, [loading, repoId, repos, load]);

  const { overview, units } = useMemo(() => groupWikiPages(pages ?? []), [pages]);
  const pagesBySlug = useMemo(
    () => new Map((pages ?? []).map((p) => [p.slug, p])),
    [pages]
  );
  const selectedPage = selectedSlug ? pagesBySlug.get(selectedSlug) ?? null : null;
  const selectedRepo = repoId ? repos.find((r) => r.id === repoId) ?? null : null;

  // Falsifiable-only rule (spec): every field here can go to zero and is
  // read straight off `wiki_pages` rows via `computeWikiSummaryStats` — no
  // derived "knowledge score". `oldestGeneratedAt` deliberately isn't
  // surfaced in the header (TASTE.md: fewer, clearer facts over a bigger
  // stat strip) — pages/stale/last-indexed/health are the ones the spec
  // keeps; per-page staleness is already visible via each page's own badge.
  const summary = useMemo(() => (pages ? computeWikiSummaryStats(pages) : null), [pages]);

  function handleRepoAdded(repo: RepoListItem) {
    setRepos((prev) => [repo, ...prev]);
  }

  if (!initialized) {
    return <LoadingState variant="list" rows={6} />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => load(repoId)} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <WikiRepoHeader
        workspaceId={workspaceId}
        repos={repos}
        selectedId={repoId}
        canManage={canManage}
        pageCount={summary?.pageCount ?? null}
        staleCount={summary?.staleCount ?? null}
        onSelect={(id) => load(id)}
        onAdded={handleRepoAdded}
      />

      {repos.length === 0 ? null : loading || repoId === null ? (
        <LoadingState variant="list" rows={4} />
      ) : pages === null || pages.length === 0 ? (
        <EmptyState
          message="No wiki compiled yet for this repository."
          action={
            <RecompileButton
              variant="button"
              workspaceId={workspaceId}
              repoFullName={selectedRepo?.name ?? ""}
              canManage={canManage}
            />
          }
        />
      ) : (
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
                workspaceId={workspaceId}
                repoFullName={selectedRepo?.name ?? ""}
                canManage={canManage}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
