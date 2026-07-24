"use client";

import { useState } from "react";
import { AlertTriangle, Download, ExternalLink, FileCode } from "lucide-react";
import { buildCitationUrl } from "../citation-url";
import {
  buildWikiMarkdownDownload,
  formatCostUsd,
  formatRelativeAge,
  shortSha,
  type WikiPageDTO,
} from "../wiki-format";
import { buildFileRosterTree } from "../wiki-tree";
import { WikiMarkdown } from "./wiki-markdown";
import { WikiFileRoster } from "./wiki-file-roster";
import { RecompileButton } from "./recompile-button";

export interface LatestCompileDTO {
  commitSha: string;
  pagesWritten: number;
  pagesReused: number;
  costUsd: number;
  model: string;
  durationMs: number;
  createdAt: string;
}

interface WikiPageViewProps {
  page: WikiPageDTO;
  repoUrl: string | null;
  latestCompile: LatestCompileDTO | null;
  pagesBySlug: Map<string, WikiPageDTO>;
  onSelectSlug: (slug: string) => void;
  workspaceId: string;
  repoFullName: string;
  canManage: boolean;
}

/** Small yellow "Stale" pill — TASTE.md Severity & Health Mapping: stale = yellow. */
function StaleBadge() {
  return (
    <span
      title="The repo has changed since this page was compiled — current inputs_hash no longer matches."
      className="inline-flex items-center gap-1 rounded-sm bg-[color-mix(in_srgb,var(--yellow-11)_16%,transparent)] px-1.5 py-0.5 text-xs font-medium text-[var(--yellow-11)]"
    >
      <AlertTriangle size={11} />
      Stale
    </span>
  );
}

/** "compiled from <short-sha> · <generatedAt relative> · <model> · last compile <cost>" (spec §4.5). */
function ProvenanceBar({
  page,
  latestCompile,
}: {
  page: WikiPageDTO;
  latestCompile: LatestCompileDTO | null;
}) {
  const parts: { key: string; node: React.ReactNode }[] = [
    { key: "sha", node: <span className="font-mono">{shortSha(page.commitSha)}</span> },
    {
      key: "age",
      node: (
        <span title={new Date(page.generatedAt).toLocaleString()}>
          {formatRelativeAge(page.generatedAt)}
        </span>
      ),
    },
    {
      key: "model",
      node: page.model ? (
        <span className="font-mono">{page.model}</span>
      ) : (
        <span className="italic">skeleton only</span>
      ),
    },
  ];
  // Omitted gracefully when there is no compile-event history yet (spec §4.5).
  if (latestCompile) {
    parts.push({
      key: "cost",
      node: <span>last compile {formatCostUsd(latestCompile.costUsd)}</span>,
    });
  }

  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--gray-09)]">
      <span>compiled from</span>
      {parts.map((part, i) => (
        <span key={part.key} className="flex items-center gap-1.5">
          {part.node}
          {i < parts.length - 1 && <span className="text-[var(--gray-07)]">·</span>}
        </span>
      ))}
    </p>
  );
}

const CHIP_CLASSNAME =
  "inline-flex items-center rounded-md border border-[var(--gray-06)] bg-[var(--gray-03)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-11)] transition-colors hover:border-[var(--gray-08)] hover:text-[var(--gray-12)]";

/** One dependency row ("Depends on" / "Used by" / "Related"): chips that jump to a sibling page within this same view. */
function DependencyRow({
  label,
  slugs,
  pagesBySlug,
  onSelectSlug,
}: {
  label: string;
  slugs: string[];
  pagesBySlug: Map<string, WikiPageDTO>;
  onSelectSlug: (slug: string) => void;
}) {
  if (slugs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-[var(--gray-09)]">{label}:</span>
      {slugs.map((slug) => {
        const target = pagesBySlug.get(slug);
        // A dangling reference (e.g. a unit page dropped since this page was
        // last regenerated) renders as inert text — never a link to nowhere.
        if (!target) {
          return (
            <span key={slug} className="text-[var(--gray-08)]">
              {slug}
            </span>
          );
        }
        return (
          <button
            key={slug}
            type="button"
            onClick={() => onSelectSlug(slug)}
            className={CHIP_CLASSNAME}
          >
            {target.title}
          </button>
        );
      })}
    </div>
  );
}

/** Every prose claim's citation, deep-linked to the repo host at the pinned commit (spec §4.5). */
function CitationsList({
  citations,
  repoUrl,
  commitSha,
}: {
  citations: string[];
  repoUrl: string | null;
  commitSha: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
        Citations
      </p>
      <ul className="flex flex-col gap-1">
        {citations.map((path) => {
          const url = repoUrl ? buildCitationUrl(repoUrl, commitSha, path) : null;
          return (
            <li key={path}>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--blue-11)] hover:underline"
                >
                  <FileCode size={12} className="shrink-0" />
                  {path}
                  <ExternalLink size={10} className="shrink-0 text-[var(--gray-08)]" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-[var(--gray-10)]">
                  <FileCode size={12} className="shrink-0" />
                  {path}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Rendered | Source" segmented toggle — the spec's "what you see is what
 * the LLM sees" made literal: Source shows `bodyMd` with zero transforms. */
function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: "rendered" | "source";
  onChange: (mode: "rendered" | "source") => void;
}) {
  const optionClass = (active: boolean) =>
    `rounded-sm px-2 py-1 text-xs font-medium transition-colors ${
      active
        ? "bg-[var(--gray-04)] text-[var(--gray-12)]"
        : "text-[var(--gray-09)] hover:text-[var(--gray-12)]"
    }`;
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="inline-flex items-center gap-0.5 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "rendered"}
        onClick={() => onChange("rendered")}
        className={optionClass(mode === "rendered")}
      >
        Rendered
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "source"}
        onClick={() => onChange("source")}
        className={optionClass(mode === "source")}
      >
        Source
      </button>
    </div>
  );
}

/** Client-side `.md` export — a frontmatter header (slug/title/kind/commitSha/
 * generatedAt/model/citations) over `bodyMd` verbatim, downloaded as a Blob.
 * No new server route: the content is already in hand from the page fetch. */
function DownloadMarkdownButton({ page }: { page: WikiPageDTO }) {
  function handleDownload() {
    const { filename, content } = buildWikiMarkdownDownload(page);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={handleDownload}
      className="inline-flex items-center gap-1 text-xs text-[var(--gray-10)] transition-colors hover:text-[var(--gray-12)]"
      title="Download this page as a standalone .md file"
    >
      <Download size={12} />
      Download .md
    </button>
  );
}

/**
 * The page view: title, provenance bar, dependency chips, VERBATIM body (in
 * either Rendered or Source form), file roster, citations. "What you see is
 * what the LLM sees" (spec §4.5) — everything here is either a direct field
 * off the `wiki_pages` row or a pure display transform of one (short sha,
 * relative age, a built URL, a built tree); nothing is console-authored
 * content.
 */
export function WikiPageView({
  page,
  repoUrl,
  latestCompile,
  pagesBySlug,
  onSelectSlug,
  workspaceId,
  repoFullName,
  canManage,
}: WikiPageViewProps) {
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const { dependsOn, dependedOnBy, related } = page.links;
  const fileRosterTree = buildFileRosterTree(page);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[var(--gray-12)]">{page.title}</h2>
              {page.stale && <StaleBadge />}
            </div>
            <ProvenanceBar page={page} latestCompile={latestCompile} />
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <ViewModeToggle mode={viewMode} onChange={setViewMode} />
            <DownloadMarkdownButton page={page} />
            <RecompileButton
              variant="link"
              workspaceId={workspaceId}
              repoFullName={repoFullName}
              canManage={canManage}
            />
          </div>
        </div>
      </div>

      {(dependsOn.length > 0 || dependedOnBy.length > 0 || related.length > 0) && (
        <div className="flex flex-col gap-1.5 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3">
          <DependencyRow
            label="Depends on"
            slugs={dependsOn}
            pagesBySlug={pagesBySlug}
            onSelectSlug={onSelectSlug}
          />
          <DependencyRow
            label="Used by"
            slugs={dependedOnBy}
            pagesBySlug={pagesBySlug}
            onSelectSlug={onSelectSlug}
          />
          <DependencyRow
            label="Related"
            slugs={related}
            pagesBySlug={pagesBySlug}
            onSelectSlug={onSelectSlug}
          />
        </div>
      )}

      {viewMode === "rendered" ? (
        <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
          <WikiMarkdown text={page.bodyMd} />
        </div>
      ) : (
        <pre className="overflow-x-auto rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4 font-mono text-xs leading-relaxed text-[var(--gray-12)] whitespace-pre-wrap">
          {page.bodyMd}
        </pre>
      )}

      {fileRosterTree && <WikiFileRoster tree={fileRosterTree} />}

      {page.citations.length > 0 && (
        <CitationsList citations={page.citations} repoUrl={repoUrl} commitSha={page.commitSha} />
      )}
    </div>
  );
}
