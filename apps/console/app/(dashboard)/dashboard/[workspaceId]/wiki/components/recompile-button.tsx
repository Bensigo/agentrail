"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
// Reused verbatim, not duplicated: this WAS the repos table's "Re-index"
// affordance before Repos & Health folded into the Wiki view (owner ruling)
// — `reindex-command.ts` relocated alongside it, unchanged. Per Repo Wiki
// spec §4.5 the wiki compile piggybacks on the exact same
// `agentrail context index` run (§4.2 "Compile trigger" — `build_index` is
// where the wiki compile step lives). This is "REUSE that exact mechanism"
// in the most literal sense available, and — deliberately — touches no
// write route: there is no existing button/endpoint that enqueues a manual
// re-onboard for an ALREADY-connected repo (`enqueueOnboard` is
// one-shot-per-repo, fired only on first connect,
// `apps/console/app/api/v1/workspaces/[workspaceId]/repos/route.ts` POST),
// so inventing one here would violate "do not invent a new write route."
// This mirrors the original repos-table's actual shipped UX (a command to
// copy, not a server enqueue) rather than the aspirational "queue-driven
// button" language — see the PR body for the full reasoning.
import { reindexCommand } from "./reindex-command";

/**
 * The "Recompile" affordance (Repo Wiki spec §4.5): relabeled, contextual
 * copy of the repos table's "Re-index" popover. `variant="link"` matches
 * that page's small text-link treatment for a control that's always present
 * once a wiki exists; `variant="button"` gives the empty state's sole
 * available action normal button weight (TASTE.md Secondary button).
 */
export function RecompileButton({ variant = "link" }: { variant?: "link" | "button" }) {
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

  const triggerClass =
    variant === "button"
      ? "inline-flex h-8 items-center gap-1.5 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-sm text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)]"
      : "inline-flex items-center gap-1 text-sm text-[var(--blue-11)] hover:underline";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button type="button" onClick={() => setOpen((o) => !o)} className={triggerClass}>
        <RefreshCw size={variant === "button" ? 13 : 12} />
        Recompile
      </button>
      {open && (
        <div
          className="absolute right-0 z-10 mt-1 w-80 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-left shadow-lg"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          <p className="mb-1 text-xs text-[var(--gray-09)]">
            Run this from the repo root to recompile the wiki:
          </p>
          <code className="block select-all rounded bg-black/30 px-2 py-1 font-mono text-xs">
            {reindexCommand()}
          </code>
        </div>
      )}
    </div>
  );
}
