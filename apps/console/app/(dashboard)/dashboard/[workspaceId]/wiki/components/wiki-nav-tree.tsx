"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { WikiPageDTO } from "../wiki-format";
import { buildWikiNavTree, type TreeNode } from "../wiki-tree";

interface WikiNavTreeProps {
  overview: WikiPageDTO | null;
  units: WikiPageDTO[];
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
}

/**
 * Left nav tree: overview on top, unit pages beneath (spec §4.5), grouped
 * hierarchically by the unit's structural repo path when the compiler has
 * populated one (owner ruling: "file structure format" — `agentrail/`,
 * `apps/` -> `console`, `jace`, `packages/` -> `db-postgres`, … — derived
 * from `skeleton.path`, NEVER by parsing the slug or the markdown body, see
 * `wiki-tree.ts`). A unit without path data (today's reality — the
 * compiler, spec PR 2, hasn't shipped yet) falls back to the flat list this
 * view always rendered, individually, right alongside the tree.
 */
export function WikiNavTree({ overview, units, selectedSlug, onSelectSlug }: WikiNavTreeProps) {
  const { tree, flat } = useMemo(() => buildWikiNavTree(units), [units]);

  return (
    <nav className="flex flex-col gap-3 text-sm" aria-label="Wiki pages">
      {overview && (
        <NavRow page={overview} selected={selectedSlug === overview.slug} onSelect={onSelectSlug} />
      )}
      {(tree.length > 0 || flat.length > 0) && (
        <div>
          <p className="px-2 pb-1 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
            Units
          </p>
          <div className="flex flex-col gap-0.5">
            {tree.map((node) => (
              <TreeGroup
                key={node.path}
                node={node}
                depth={0}
                selectedSlug={selectedSlug}
                onSelectSlug={onSelectSlug}
              />
            ))}
            {flat.map((page) => (
              <NavRow
                key={page.slug}
                page={page}
                selected={selectedSlug === page.slug}
                onSelect={onSelectSlug}
              />
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}

/** One directory level of the hierarchical grouping — collapsible, default
 * expanded (there's little to hide at typical repo depths, and the whole
 * point is letting the wiki be browsed like the codebase it describes). A
 * node with no unit attached (a pure intermediate directory, e.g. "apps/")
 * renders as a folder row; a node WITH a unit attached renders as a page row
 * — the rare case of a unit that owns both files and a path prefix other
 * units share is still just one more child level. */
function TreeGroup({
  node,
  depth,
  selectedSlug,
  onSelectSlug,
}: {
  node: TreeNode<WikiPageDTO>;
  depth: number;
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const isLeaf = node.value !== undefined && node.children.length === 0;
  const indent = depth * 14;

  if (isLeaf) {
    return (
      <NavRow
        page={node.value!}
        selected={selectedSlug === node.value!.slug}
        onSelect={onSelectSlug}
        indentPx={indent}
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: indent }}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[var(--gray-10)] transition-colors duration-150 hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0" />
        ) : (
          <ChevronRight size={12} className="shrink-0" />
        )}
        <Folder size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {node.value !== undefined && (
            <NavRow
              page={node.value}
              selected={selectedSlug === node.value.slug}
              onSelect={onSelectSlug}
              indentPx={indent + 14}
            />
          )}
          {node.children.map((child) => (
            <TreeGroup
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedSlug={selectedSlug}
              onSelectSlug={onSelectSlug}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavRow({
  page,
  selected,
  onSelect,
  indentPx = 0,
}: {
  page: WikiPageDTO;
  selected: boolean;
  onSelect: (slug: string) => void;
  indentPx?: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(page.slug)}
      aria-current={selected ? "page" : undefined}
      style={indentPx ? { paddingLeft: indentPx + 8 } : undefined}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors duration-150 ${
        selected
          ? "bg-[var(--gray-03)] font-medium text-[var(--gray-12)]"
          : "text-[var(--gray-11)] hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
      }`}
    >
      {/* UI names over IDs: the page title, never the slug. */}
      <span className="min-w-0 flex-1 truncate">{page.title}</span>
      {page.stale && (
        <span
          aria-label="Stale"
          title="Stale"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--yellow-09)]"
        />
      )}
    </button>
  );
}
