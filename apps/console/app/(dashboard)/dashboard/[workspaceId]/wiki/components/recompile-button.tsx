"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Terminal } from "lucide-react";
// Demoted, not deleted: `reindexCommand` is the exact command a SELF-HOSTED
// operator (no hosted queue reachable) still needs to run by hand. Repo Wiki
// spec §4.5 makes the hosted enqueue below the PRIMARY affordance; the CLI
// command survives only as a small secondary hint (see its render sites
// further down).
import { reindexCommand } from "./reindex-command";

type RecompileState =
  | { kind: "idle" }
  | { kind: "queueing" }
  | { kind: "queued" }
  | { kind: "already_pending" }
  | { kind: "error"; message: string };

// How long the "Queued" / "Already queued" result stays visible before the
// button resets to idle and is clickable again — long enough to read
// comfortably, short enough that the affordance doesn't feel stuck. This is
// a persisted STATUS message, not a transition, so it gets a
// human-reading-speed window rather than a sub-second motion budget. An
// error is left open until the user dismisses it (click elsewhere / Escape)
// or retries — it must not vanish before it's been read.
const RESULT_VISIBLE_MS = 6000;

interface RecompileButtonProps {
  variant?: "link" | "button";
  workspaceId: string;
  repoFullName: string;
  canManage: boolean;
}

/**
 * The REAL "Recompile" affordance (Repo Wiki spec §4.5 — owner ruling: "I
 * expect it to happen on its own"). A click POSTs to
 * `.../wiki/recompile`, which force-requeues the repo's existing onboard-kind
 * work item server-side — audited, queue-driven, no direct console-to-LLM
 * call from this component. This REPLACES the prior copy-paste-only
 * popover: there was previously no write route that could re-enqueue an
 * ALREADY-connected repo's onboard job (`enqueueOnboard` was one-shot-per-
 * repo, fired only on first connect), so the original version of this
 * component could only show the `agentrail context index` command. That
 * command still exists — as a small secondary hint for self-hosters running
 * their own runner instead of the hosted queue, not the primary action.
 *
 * `canManage=false` hides the button entirely — the same precedent
 * `WikiRepoList`'s "Add repository" affordance uses (owner/admin only).
 */
export function RecompileButton({
  variant = "link",
  workspaceId,
  repoFullName,
  canManage,
}: RecompileButtonProps) {
  const [state, setState] = useState<RecompileState>({ kind: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  // Dismiss an open result panel (queued / already-pending / error) on an
  // outside click or Escape — same idiom the original CLI-command popover
  // used, kept for the panel that replaces it.
  useEffect(() => {
    if (state.kind === "idle" || state.kind === "queueing") return;
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setState({ kind: "idle" });
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setState({ kind: "idle" });
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [state.kind]);

  if (!canManage) return null;

  async function handleClick() {
    if (state.kind === "queueing") return;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setState({ kind: "queueing" });
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/wiki/recompile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      }
      const next: RecompileState =
        data.status === "already_pending" ? { kind: "already_pending" } : { kind: "queued" };
      setState(next);
      resetTimer.current = setTimeout(() => setState({ kind: "idle" }), RESULT_VISIBLE_MS);
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to queue recompile",
      });
    }
  }

  const triggerClass =
    variant === "button"
      ? "inline-flex h-8 items-center gap-1.5 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-sm text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)] disabled:cursor-not-allowed disabled:opacity-60"
      : "inline-flex items-center gap-1 text-sm text-[var(--blue-11)] hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline";

  const busy = state.kind === "queueing";
  const showPanel =
    state.kind === "queued" || state.kind === "already_pending" || state.kind === "error";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={triggerClass}
        title="Enqueue a fresh wiki compile for this repository"
      >
        {busy ? (
          <Loader2 size={variant === "button" ? 13 : 12} className="animate-spin" />
        ) : (
          <RefreshCw size={variant === "button" ? 13 : 12} />
        )}
        {busy ? "Queueing…" : "Recompile"}
      </button>

      {showPanel && (
        <div
          role="status"
          className="absolute right-0 z-10 mt-1 w-72 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-left shadow-lg"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          {state.kind === "queued" && (
            <p className="text-xs text-[var(--green-11)]">
              Queued — Jace&apos;s factory will recompile shortly
            </p>
          )}
          {state.kind === "already_pending" && (
            <p className="text-xs text-[var(--gray-10)]">
              Already queued — a recompile is already in flight for this repo
            </p>
          )}
          {state.kind === "error" && (
            <p className="text-xs text-[var(--red-11)]">{state.message}</p>
          )}
        </div>
      )}

      {/* Self-hosted fallback — a small secondary hint, no longer the
          primary affordance (spec §4.5). The roomy empty-state ("button"
          variant) gets a permanent caption; the tight page-header ("link"
          variant) collapses it behind a small icon so it never crowds the
          row. */}
      {variant === "button" ? (
        <p className="mt-1.5 text-[11px] text-[var(--gray-08)]">
          Self-hosting?{" "}
          <code className="rounded bg-black/20 px-1 py-0.5 font-mono">{reindexCommand()}</code>
        </p>
      ) : (
        <CliHintToggle />
      )}
    </div>
  );
}

/** Collapsed CLI-command detail for the compact "link" variant — a small
 * icon toggle so the self-hosted fallback never crowds a tight header row. */
function CliHintToggle() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
    <span ref={ref} className="relative ml-1 inline-block align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Self-hosted recompile command"
        aria-label="Self-hosted recompile command"
        className="text-[var(--gray-08)] transition-colors hover:text-[var(--gray-10)]"
      >
        <Terminal size={11} />
      </button>
      {open && (
        <div
          className="absolute right-0 z-10 mt-1 w-72 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-3 text-left shadow-lg"
          style={{ boxShadow: "var(--shadow-dropdown)" }}
        >
          <p className="mb-1 text-xs text-[var(--gray-09)]">
            Self-hosting? Run this from the repo root instead:
          </p>
          <code className="block select-all rounded bg-black/30 px-2 py-1 font-mono text-xs">
            {reindexCommand()}
          </code>
        </div>
      )}
    </span>
  );
}
