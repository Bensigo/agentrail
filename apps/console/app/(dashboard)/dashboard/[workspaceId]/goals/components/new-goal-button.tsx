"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";

export interface RepositoryOption {
  id: string;
  name: string;
}

interface NewGoalButtonProps {
  workspaceId: string;
  /** The workspace's own repositories — a goal is REQUIRED to be tied to
   * one of these (server-enforced too, see the goals POST route's own
   * `getRepository` check). Callers only render this button at all when
   * this list is non-empty (see `page.tsx`'s own repo-required empty
   * state) — this component doesn't re-check that itself. */
  repositories: RepositoryOption[];
}

type CheckType = "metric" | "command";

const DEFAULT_MAX_ISSUES = 10;
const DEFAULT_MAX_SPEND_USD = 50;

/** Same input recipe as every other console modal (add-repository-dialog.tsx, invite-member-dialog.tsx) — this IS a dialog form, unlike the chat composer, so the ring-focus/dialog-panel convention is the right fit here. */
const INPUT_CLASSNAME =
  "h-8 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]";

/**
 * "New goal" trigger + dialog (#1289 AC — the goal loop shipped with no way
 * for a human to START one from the console). Owns its own `open` state
 * (there's no sibling "table" component on the Goals page to own it the way
 * `ReposTable` owns `AddRepositoryDialog`'s), and calls `router.refresh()`
 * on success rather than pushing the new row into local state — the page
 * is a server component reading `listGoalsForWorkspace` directly (Budget-page
 * precedent: "no client fetch"), so a refresh is what actually re-runs that
 * read and shows the new goal in the Active section.
 */
export function NewGoalButton({ workspaceId, repositories }: NewGoalButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [objective, setObjective] = useState("");
  // Defaults to the sole repo when there's only one — the picker still
  // renders (a human can see which repo a goal will file issues against),
  // it's just pre-filled rather than forcing a redundant choice.
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const [maxIssues, setMaxIssues] = useState(String(DEFAULT_MAX_ISSUES));
  const [maxSpendUsd, setMaxSpendUsd] = useState(String(DEFAULT_MAX_SPEND_USD));
  const [checkType, setCheckType] = useState<CheckType>("metric");
  const [checkThreshold, setCheckThreshold] = useState("");
  const [checkCommand, setCheckCommand] = useState("");

  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  function reset() {
    setObjective("");
    setRepositoryId(repositories[0]?.id ?? "");
    setMaxIssues(String(DEFAULT_MAX_ISSUES));
    setMaxSpendUsd(String(DEFAULT_MAX_SPEND_USD));
    setCheckType("metric");
    setCheckThreshold("");
    setCheckCommand("");
    setFieldErrors({});
    setServerError(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFieldErrors({});
    setServerError(null);

    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          objective: objective.trim(),
          repository_id: repositoryId,
          max_issues: Number(maxIssues),
          max_spend_usd: Number(maxSpendUsd),
          check_type: checkType,
          ...(checkType === "metric" && checkThreshold.trim()
            ? { check_threshold: Number(checkThreshold) }
            : {}),
          ...(checkType === "command" ? { check_command: checkCommand.trim() } : {}),
        }),
      });

      const raw = await res.text();
      let data: { goal?: unknown; error?: string; errors?: Record<string, string> } = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          // Non-JSON body — fall through to a status-based error message below.
        }
      }

      if (!res.ok) {
        if (data.errors) {
          setFieldErrors(data.errors);
        } else {
          setServerError(data.error ?? `Request failed (HTTP ${res.status})`);
        }
        return;
      }

      close();
      router.refresh();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to create goal");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded bg-[var(--yellow-09)] px-3 text-sm font-medium text-black transition-colors hover:bg-[var(--yellow-09-hover)]"
      >
        <Plus size={14} />
        New goal
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            className="relative w-full max-w-md rounded bg-[var(--gray-02)] border border-[var(--gray-05)] p-6"
            style={{ boxShadow: "var(--shadow-overlay)" }}
          >
            <button
              onClick={close}
              className="absolute top-4 right-4 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-4">New goal</h2>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-objective">
                  Objective
                </label>
                <textarea
                  id="goal-objective"
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="e.g. Reach 80% test coverage"
                  rows={3}
                  required
                  className="resize-none rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 py-2 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
                  autoFocus
                />
                {fieldErrors.objective && (
                  <p className="text-xs text-[var(--red-11)]">{fieldErrors.objective}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-repository">
                  Repository
                </label>
                <select
                  id="goal-repository"
                  value={repositoryId}
                  onChange={(e) => setRepositoryId(e.target.value)}
                  required
                  className={INPUT_CLASSNAME}
                >
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                </select>
                {fieldErrors.repository_id && (
                  <p className="text-xs text-[var(--red-11)]">{fieldErrors.repository_id}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-max-issues">
                    Max issues
                  </label>
                  <input
                    id="goal-max-issues"
                    type="number"
                    min={1}
                    max={100}
                    value={maxIssues}
                    onChange={(e) => setMaxIssues(e.target.value)}
                    required
                    className={INPUT_CLASSNAME}
                  />
                  {fieldErrors.max_issues && (
                    <p className="text-xs text-[var(--red-11)]">{fieldErrors.max_issues}</p>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-max-spend">
                    Max spend (USD)
                  </label>
                  <input
                    id="goal-max-spend"
                    type="number"
                    min={1}
                    max={1000}
                    value={maxSpendUsd}
                    onChange={(e) => setMaxSpendUsd(e.target.value)}
                    required
                    className={INPUT_CLASSNAME}
                  />
                  {fieldErrors.max_spend_usd && (
                    <p className="text-xs text-[var(--red-11)]">{fieldErrors.max_spend_usd}</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-check-type">
                  Check type
                </label>
                <select
                  id="goal-check-type"
                  value={checkType}
                  onChange={(e) => setCheckType(e.target.value as CheckType)}
                  className={INPUT_CLASSNAME}
                >
                  <option value="metric">Metric — green-run count</option>
                  <option value="command">Command — checked manually</option>
                </select>
              </div>

              {checkType === "metric" ? (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-check-threshold">
                    Target green-run count (optional)
                  </label>
                  <input
                    id="goal-check-threshold"
                    type="number"
                    min={1}
                    value={checkThreshold}
                    onChange={(e) => setCheckThreshold(e.target.value)}
                    placeholder="e.g. 5"
                    className={INPUT_CLASSNAME}
                  />
                  {fieldErrors.check_threshold && (
                    <p className="text-xs text-[var(--red-11)]">{fieldErrors.check_threshold}</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-[var(--gray-10)]" htmlFor="goal-check-command">
                    Command to satisfy the check
                  </label>
                  <input
                    id="goal-check-command"
                    type="text"
                    value={checkCommand}
                    onChange={(e) => setCheckCommand(e.target.value)}
                    placeholder="e.g. pnpm test --filter flaky"
                    required
                    className={`${INPUT_CLASSNAME} font-mono`}
                  />
                  {fieldErrors.check_command && (
                    <p className="text-xs text-[var(--red-11)]">{fieldErrors.check_command}</p>
                  )}
                </div>
              )}

              {serverError && <p className="text-xs text-[var(--red-11)]">{serverError}</p>}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={close}
                  className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !objective.trim() || !repositoryId}
                  className="h-8 px-4 rounded bg-[var(--yellow-09)] text-black text-sm font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
                >
                  {loading ? "Creating…" : "Create goal"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
