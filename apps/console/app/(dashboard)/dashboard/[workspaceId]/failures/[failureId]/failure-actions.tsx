"use client";

import { useState } from "react";
import { Check, CircleDot, BookmarkPlus, GitPullRequestArrow } from "lucide-react";

type Status = "open" | "fixed";
type IssueTarget = "github" | "linear";

const TARGET_LABEL: Record<IssueTarget, string> = {
  github: "GitHub",
  linear: "Linear",
};

interface FailureActionsProps {
  workspaceId: string;
  failureId: string;
  initialStatus: Status;
  /** Issue trackers this failure can be filed to (github and/or linear). */
  issueTargets: IssueTarget[];
}

type ActionState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; message: string; url?: string }
  | { kind: "error"; message: string };

export function FailureActions({
  workspaceId,
  failureId,
  initialStatus,
  issueTargets,
}: FailureActionsProps) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [statusBusy, setStatusBusy] = useState(false);
  const [memoryState, setMemoryState] = useState<ActionState>({ kind: "idle" });
  const [issueState, setIssueState] = useState<ActionState>({ kind: "idle" });
  // When more than one tracker is connected, clicking "Create issue" reveals a
  // choice instead of filing immediately.
  const [choosing, setChoosing] = useState(false);

  const base = `/api/v1/workspaces/${workspaceId}/failures/${failureId}`;

  async function toggleStatus() {
    const next: Status = status === "fixed" ? "open" : "fixed";
    setStatusBusy(true);
    try {
      const res = await fetch(`${base}/resolution`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { status: Status };
      setStatus(json.status);
    } catch {
      // leave status unchanged; the button stays actionable
    } finally {
      setStatusBusy(false);
    }
  }

  async function addToMemory() {
    setMemoryState({ kind: "busy" });
    try {
      const res = await fetch(`${base}/memory`, { method: "POST" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setMemoryState({ kind: "ok", message: "Saved to memory" });
    } catch (e) {
      setMemoryState({
        kind: "error",
        message: e instanceof Error ? e.message : "Failed to save",
      });
    }
  }

  async function createIssue(target: IssueTarget) {
    setChoosing(false);
    setIssueState({ kind: "busy" });
    try {
      const res = await fetch(`${base}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const b = (await res.json().catch(() => ({}))) as {
        error?: string;
        url?: string;
        number?: number;
        identifier?: string;
      };
      if (!res.ok) throw new Error(b.error ?? `HTTP ${res.status}`);
      const ref = b.number ? `#${b.number}` : (b.identifier ?? "");
      setIssueState({
        kind: "ok",
        message: `${TARGET_LABEL[target]} issue ${ref} created`.replace("  ", " ").trim(),
        url: b.url,
      });
    } catch (e) {
      setIssueState({
        kind: "error",
        message: e instanceof Error ? e.message : "Failed to create issue",
      });
    }
  }

  // One tracker → file directly; several → reveal the choice first.
  function onCreateIssueClick() {
    if (issueTargets.length === 1) createIssue(issueTargets[0]!);
    else setChoosing((v) => !v);
  }

  const isFixed = status === "fixed";
  const canCreateIssue = issueTargets.length > 0;

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-4 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={status} />
          <span className="text-xs text-[var(--gray-09)]">
            {isFixed
              ? "Marked fixed — hidden from your open work."
              : "Still open — not yet resolved."}
          </span>
        </div>
        <button
          onClick={toggleStatus}
          disabled={statusBusy}
          className={`inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium border transition-colors disabled:opacity-50 ${
            isFixed
              ? "bg-[var(--gray-03)] border-[var(--gray-06)] text-[var(--gray-11)] hover:border-[var(--gray-08)]"
              : "bg-[var(--fixed-09)]/15 border-[var(--fixed-09)]/40 text-[var(--fixed-11)] hover:bg-[var(--fixed-09)]/25"
          }`}
        >
          {isFixed ? (
            <>
              <CircleDot className="h-3.5 w-3.5" /> Reopen
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5" /> Mark as fixed
            </>
          )}
        </button>
      </div>

      <div className="h-px bg-[var(--gray-05)]" />

      <div className="flex flex-wrap items-center gap-3">
        {/* Add to memory */}
        <div className="flex items-center gap-2">
          <button
            onClick={addToMemory}
            disabled={memoryState.kind === "busy" || memoryState.kind === "ok"}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium bg-[var(--gray-03)] border border-[var(--gray-06)] text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-60 transition-colors"
          >
            <BookmarkPlus className="h-3.5 w-3.5" />
            {memoryState.kind === "busy"
              ? "Saving…"
              : memoryState.kind === "ok"
                ? "Saved"
                : "Add to memory"}
          </button>
          {memoryState.kind === "ok" && (
            <span className="text-xs text-[var(--fixed-11)]">{memoryState.message}</span>
          )}
          {memoryState.kind === "error" && (
            <span className="text-xs text-[var(--red-11)]">{memoryState.message}</span>
          )}
        </div>

        {/* Create issue */}
        <div className="relative flex items-center gap-2">
          <button
            onClick={onCreateIssueClick}
            disabled={
              !canCreateIssue ||
              issueState.kind === "busy" ||
              issueState.kind === "ok"
            }
            title={
              canCreateIssue
                ? issueTargets.length > 1
                  ? "Choose where to file this failure"
                  : `File this failure on ${TARGET_LABEL[issueTargets[0]!]}`
                : "Connect GitHub (with repo scope) or Linear to file issues."
            }
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium bg-[var(--gray-03)] border border-[var(--gray-06)] text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-60 transition-colors"
          >
            <GitPullRequestArrow className="h-3.5 w-3.5" />
            {issueState.kind === "busy"
              ? "Filing…"
              : issueState.kind === "ok"
                ? "Filed"
                : issueTargets.length > 1
                  ? "Create issue…"
                  : "Create issue"}
          </button>

          {/* Tracker choice — only when more than one is connected */}
          {choosing && issueTargets.length > 1 && (
            <div className="absolute top-9 left-0 z-10 flex flex-col gap-1 rounded border border-[var(--gray-06)] bg-[var(--gray-02)] p-1 shadow-lg">
              {issueTargets.map((t) => (
                <button
                  key={t}
                  onClick={() => createIssue(t)}
                  className="whitespace-nowrap rounded px-2.5 py-1.5 text-left text-xs text-[var(--gray-12)] hover:bg-[var(--gray-04)] transition-colors"
                >
                  File on {TARGET_LABEL[t]}
                </button>
              ))}
            </div>
          )}

          {issueState.kind === "ok" &&
            (issueState.url && /^https:\/\//i.test(issueState.url) ? (
              <a
                href={issueState.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-[var(--fixed-11)] hover:underline"
              >
                {issueState.message} →
              </a>
            ) : (
              <span className="text-xs text-[var(--fixed-11)]">{issueState.message}</span>
            ))}
          {issueState.kind === "error" && (
            <span className="text-xs text-[var(--red-11)]">{issueState.message}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "fixed") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium bg-[var(--fixed-09)]/20 text-[var(--fixed-11)] border border-[var(--fixed-09)]/30">
        <Check className="h-3 w-3" /> Fixed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-medium bg-[var(--orange-09)]/20 text-[var(--orange-11)] border border-[var(--orange-09)]/30">
      <CircleDot className="h-3 w-3" /> Open
    </span>
  );
}
