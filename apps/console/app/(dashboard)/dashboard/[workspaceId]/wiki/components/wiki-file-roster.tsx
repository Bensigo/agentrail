"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FileCode } from "lucide-react";
import type { TreeNode } from "../wiki-tree";

/**
 * A unit's file roster (`skeleton.files`) rendered as an actual collapsible
 * file tree — the "Structure" section's data made literal (owner ruling:
 * "render the llm wiki in file structure format"). Read-only, purely
 * informational: no click behavior, unlike the nav tree's page rows.
 */
export function WikiFileRoster({ tree }: { tree: TreeNode<string>[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-normal uppercase tracking-wide text-[var(--gray-09)]">
        Files
      </p>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-2">
        <div className="flex flex-col gap-0.5">
          {tree.map((node) => (
            <FileRosterNode key={node.path} node={node} depth={0} />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileRosterNode({ node, depth }: { node: TreeNode<string>; depth: number }) {
  const [open, setOpen] = useState(true);
  const isFile = node.value !== undefined && node.children.length === 0;
  const indent = depth * 14;

  if (isFile) {
    return (
      <div
        style={{ paddingLeft: indent + 8 }}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--gray-11)]"
      >
        <FileCode size={12} className="shrink-0 text-[var(--gray-08)]" />
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ paddingLeft: indent }}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-[var(--gray-10)] transition-colors duration-150 hover:bg-[var(--gray-02)] hover:text-[var(--gray-12)]"
      >
        {open ? (
          <ChevronDown size={11} className="shrink-0" />
        ) : (
          <ChevronRight size={11} className="shrink-0" />
        )}
        <Folder size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <FileRosterNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
