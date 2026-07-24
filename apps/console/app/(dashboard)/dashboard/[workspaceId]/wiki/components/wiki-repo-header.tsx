"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Plus } from "lucide-react";
// Cross-feature import, deliberate: `add-repository-dialog.tsx` stays at its
// original path — `setup/components/github-step.tsx` (another active
// workstream) imports it from exactly this path too, and that dir is
// off-limits to touch here. This is the ONE management affordance that
// survives the Repos & Health -> Wiki fold (owner ruling); it POSTs to the
// same `.../repos` route it always has, unchanged.
import { AddRepositoryDialog, type RepoRow } from "../../repos/components/add-repository-dialog";
import {
  formatPageCount,
  formatRelativeAge,
  formatRepoDetailLine,
  healthStatusLabel,
  type RepoListItem,
} from "../wiki-format";
import type { HealthStatus } from "../../../../../../lib/repo-health";
import { RecompileButton } from "./recompile-button";

interface WikiRepoHeaderProps {
  workspaceId: string;
  repos: RepoListItem[];
  selectedId: string | null;
  canManage: boolean;
  /** null while the selected repo's pages haven't loaded yet (initial
   * multi-repo auto-select tick, or an in-flight repo switch) — the facts
   * that depend on them stay hidden rather than showing a stale count. */
  pageCount: number | null;
  staleCount: number | null;
  onSelect: (id: string) => void;
  onAdded: (repo: RepoListItem) => void;
}

const HEALTH_DOT_CLASS: Record<HealthStatus, string> = {
  healthy: "bg-[var(--green-09)]",
  stale: "bg-[var(--yellow-09)]",
  critical: "bg-[var(--red-09)]",
};

const HEALTH_TEXT_CLASS: Record<HealthStatus, string> = {
  healthy: "text-[var(--green-11)]",
  stale: "text-[var(--yellow-11)]",
  critical: "text-[var(--red-11)]",
};

function repoRowFromApi(repo: RepoRow): RepoListItem {
  return {
    id: repo.id,
    name: repo.name,
    healthStatus: repo.health_status,
    lastIndexedAt: repo.last_indexed_at,
    lastCommitSha: repo.last_commit_sha,
    sourceCount: repo.codebase_units_count !== null ? Number(repo.codebase_units_count) : null,
  };
}

function HealthDot({ status }: { status: HealthStatus }) {
  return (
    <span
      aria-hidden
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_DOT_CLASS[status]}`}
    />
  );
}

/** Inline "·" separator — matches `wiki-page-view.tsx`'s `ProvenanceBar`,
 * the platform's one existing precedent for a dense, single-line, multi-fact
 * display (this header follows the same technique deliberately). */
function Sep() {
  return (
    <span aria-hidden className="text-[var(--gray-07)]">
      ·
    </span>
  );
}

/** Non-zero-only stale count pill — same bg/text treatment as
 * `wiki-page-view.tsx`'s per-page `StaleBadge`, but a repo-level count
 * rather than a single page's flag. Falsifiable-only rule (spec): a healthy
 * repo (staleCount === 0) shows nothing here, never "0 stale". */
function StaleCountBadge({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] px-1.5 py-0.5 text-xs font-medium text-[var(--yellow-11)]">
      <AlertTriangle size={11} />
      {count} stale
    </span>
  );
}

/** Compact dropdown picker for a multi-repo workspace — repo name + health
 * dot in the trigger, full list (each with its own dot) in the popover.
 * Modeled directly on `WorkspaceSwitcher.tsx` (the platform's one existing
 * "pick one of N, switch the view below" component): same trigger/listbox
 * shape, same outside-click + Escape dismissal idiom. */
function RepoPicker({
  repos,
  selected,
  onSelect,
}: {
  repos: RepoListItem[];
  selected: RepoListItem | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 text-sm text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)]"
      >
        {selected ? (
          <>
            <HealthDot status={selected.healthStatus} />
            <span className="max-w-[220px] truncate font-semibold">{selected.name}</span>
          </>
        ) : (
          <span className="text-[var(--gray-09)]">Select a repository</span>
        )}
        <ChevronDown size={12} className="shrink-0 text-[var(--gray-09)]" />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Repositories"
          className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-[var(--gray-05)] bg-[var(--gray-02)] py-1 shadow-2xl"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          <div className="max-h-72 overflow-y-auto">
            {repos.map((repo) => {
              const isActive = selected?.id === repo.id;
              return (
                <button
                  key={repo.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(repo.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--gray-03)] focus:outline-none focus-visible:bg-[var(--gray-03)]"
                >
                  <HealthDot status={repo.healthStatus} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--gray-12)]">
                    {repo.name}
                  </span>
                  {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--gray-12)]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The wiki page's header band — repo selection and health, demoted from a
 * full-width table to a compact single line above the wiki (owner feedback
 * on the live page: the knowledge was buried under the table — "am I
 * supposed to click the repo to see the wiki?"). Single-repo workspaces (the
 * common case) get repo name + health + last-indexed + pages/stale inline,
 * one line, no picker needed. Multi-repo workspaces get a compact dropdown
 * picker instead of a table row-per-repo; the full health detail (last
 * indexed, commit, sources) collapses into a one-line subheader for the
 * SELECTED repo only, since the picker control itself already claims space
 * on the primary line. "Add repository" is the one write affordance that
 * survives the fold (owner ruling) — gated to owner/admin, tucked into a
 * quiet right-aligned link so it never competes with the wiki content below.
 * Owns its own "no repos yet" empty state (rather than `wiki-client.tsx`
 * linking to `/repos`, which is now a redirect stub back to `/wiki` — that
 * would bounce).
 */
export function WikiRepoHeader({
  workspaceId,
  repos,
  selectedId,
  canManage,
  pageCount,
  staleCount,
  onSelect,
  onAdded,
}: WikiRepoHeaderProps) {
  const [showAdd, setShowAdd] = useState(false);

  function handleAdded(repo: RepoRow) {
    onAdded(repoRowFromApi(repo));
    setShowAdd(false);
  }

  if (repos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded border border-[var(--gray-05)] py-8 text-center">
        <p className="text-sm text-[var(--gray-09)]">No repositories connected yet.</p>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="text-sm text-[var(--blue-11)] hover:underline"
          >
            Add your first repository →
          </button>
        )}
        {showAdd && (
          <AddRepositoryDialog
            workspaceId={workspaceId}
            onAdded={handleAdded}
            onClose={() => setShowAdd(false)}
          />
        )}
      </div>
    );
  }

  const selectedRepo = selectedId ? repos.find((r) => r.id === selectedId) ?? null : null;
  const multi = repos.length > 1;

  return (
    <div className="flex flex-col gap-1 border-b border-[var(--gray-05)] pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          {multi ? (
            <RepoPicker repos={repos} selected={selectedRepo} onSelect={onSelect} />
          ) : (
            selectedRepo && (
              <>
                {/* UI names over IDs: the repo name, never its id. */}
                <span className="text-sm font-semibold text-[var(--gray-12)]">
                  {selectedRepo.name}
                </span>
                <Sep />
                <span
                  className={`inline-flex items-center gap-1 text-xs font-medium ${HEALTH_TEXT_CLASS[selectedRepo.healthStatus]}`}
                >
                  <HealthDot status={selectedRepo.healthStatus} />
                  {healthStatusLabel(selectedRepo.healthStatus)}
                </span>
                <Sep />
                <span className="text-xs text-[var(--gray-09)]">
                  last indexed{" "}
                  <span className="font-mono text-[var(--gray-10)]">
                    {selectedRepo.lastIndexedAt
                      ? formatRelativeAge(selectedRepo.lastIndexedAt)
                      : "never"}
                  </span>
                </span>
              </>
            )
          )}
          {selectedRepo && pageCount !== null && (
            <>
              <Sep />
              <span className="text-xs text-[var(--gray-09)]">{formatPageCount(pageCount)}</span>
            </>
          )}
          {selectedRepo && staleCount !== null && staleCount > 0 && (
            <>
              <Sep />
              <StaleCountBadge count={staleCount} />
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {selectedRepo && (
            <RecompileButton
              variant="link"
              workspaceId={workspaceId}
              repoFullName={selectedRepo.name}
              canManage={canManage}
            />
          )}
          {canManage && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1 text-xs text-[var(--blue-11)] hover:underline"
            >
              <Plus size={12} />
              Add repository
            </button>
          )}
        </div>
      </div>

      {multi && selectedRepo && (
        <p className="text-xs text-[var(--gray-09)]">{formatRepoDetailLine(selectedRepo)}</p>
      )}

      {showAdd && (
        <AddRepositoryDialog
          workspaceId={workspaceId}
          onAdded={handleAdded}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
