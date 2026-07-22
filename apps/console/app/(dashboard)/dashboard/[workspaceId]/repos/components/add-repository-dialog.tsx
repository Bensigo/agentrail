"use client";

import { useEffect, useRef, useState } from "react";
import { X, Search, Lock, Globe, Check, Loader2, PenLine } from "lucide-react";

export interface RepoRow {
  id: string;
  name: string;
  url: string;
  default_branch: string;
  last_indexed_at: string | null;
  last_commit_sha: string | null;
  staleness_seconds: number | null;
  codebase_units_count: number | null;
  health_status: "healthy" | "stale" | "critical";
}

/** One repository as returned by GET .../github/repos (snake_case wire, #1293). */
interface PickerRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

interface AddRepositoryDialogProps {
  workspaceId: string;
  onAdded: (repo: RepoRow) => void;
  onClose: () => void;
}

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_UNSAFE_RE = /[\x00-\x1f\x7f ~^:?*[\\\s]|\.\.|\.lock$|\/$/;

function isGitSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("/") && !GIT_UNSAFE_RE.test(ref);
}

function validateName(name: string): string | null {
  if (!name) return "Required";
  if (!REPO_NAME_RE.test(name)) return "Must match owner/repo format";
  return null;
}

function validateUrl(url: string, name: string): string | null {
  if (!url) return "Required";
  const prefix = "https://github.com/";
  if (!url.startsWith(prefix)) return "Must start with https://github.com/";
  const urlPath = url.slice(prefix.length).replace(/\/$/, "");
  if (name && REPO_NAME_RE.test(name) && urlPath !== name) {
    return `Path must match repository name`;
  }
  return null;
}

function validateBranch(branch: string): string | null {
  if (!branch) return "Required";
  if (!isGitSafeRef(branch)) return "Must be a valid git ref name";
  return null;
}

const INPUT_CLASS =
  "h-8 w-full rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-text)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]";

/** Small private/public pill matching the repo-pill treatment in the wizard. */
function VisibilityHint({ isPrivate }: { isPrivate: boolean }) {
  return (
    <span
      className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-sm border border-[var(--gray-05)] bg-[var(--gray-02)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--gray-09)]"
      aria-label={isPrivate ? "Private repository" : "Public repository"}
    >
      {isPrivate ? <Lock size={9} /> : <Globe size={9} />}
      {isPrivate ? "Private" : "Public"}
    </span>
  );
}

export function AddRepositoryDialog({
  workspaceId,
  onAdded,
  onClose,
}: AddRepositoryDialogProps) {
  const [mode, setMode] = useState<"picker" | "manual">("picker");

  // Values that get POSTed — filled by a picker selection OR typed in manual.
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");

  // Picker state.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerRepo[]>([]);
  const [listState, setListState] = useState<"loading" | "loaded" | "error">(
    "loading"
  );
  const [listError, setListError] = useState<{
    message: string;
    code?: string;
  } | null>(null);
  const [open, setOpen] = useState(true);
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<PickerRepo | null>(null);

  // Manual state.
  const [touched, setTouched] = useState({
    name: false,
    url: false,
    default_branch: false,
  });

  // Submit state.
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced repo fetch — runs whenever the picker dropdown is open and the
  // query changes. A programmatic query change made while closing (i.e. right
  // after a selection) is guarded out by the `!open` check, so picking a repo
  // doesn't trigger a needless refetch.
  useEffect(() => {
    if (mode !== "picker" || !open) return;
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setListState("loading");
      setListError(null);
      try {
        const params = new URLSearchParams();
        const q = query.trim();
        if (q) params.set("q", q);
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/github/repos?${params.toString()}`,
          { signal: controller.signal }
        );
        const data = (await res.json().catch(() => ({}))) as {
          repos?: PickerRepo[];
          error?: string;
          code?: string;
        };
        if (!res.ok) {
          setResults([]);
          setListState("error");
          setListError({
            message: data.error ?? `Request failed (HTTP ${res.status})`,
            code: data.code,
          });
          return;
        }
        setResults(data.repos ?? []);
        setHighlight(0);
        setListState("loaded");
      } catch {
        if (controller.signal.aborted) return;
        setResults([]);
        setListState("error");
        setListError({ message: "Failed to load repositories" });
      }
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, open, mode, workspaceId]);

  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  function selectRepo(repo: PickerRepo) {
    setSelected(repo);
    setName(repo.full_name);
    setUrl(repo.html_url);
    setDefaultBranch(repo.default_branch || "main");
    setQuery(repo.full_name);
    setOpen(false);
    setServerError(null);
  }

  function clearSelection() {
    setSelected(null);
    setName("");
    setUrl("");
    setQuery("");
    setOpen(true);
  }

  // Manual validation (only meaningful in manual mode).
  const nameError = validateName(name);
  const urlError = validateUrl(url, name);
  const branchError = validateBranch(defaultBranch);
  const manualValid = !nameError && !urlError && !branchError;

  function handleManualNameChange(val: string) {
    setName(val);
    if (REPO_NAME_RE.test(val.trim()) && !url) {
      setUrl(`https://github.com/${val.trim()}`);
    }
  }

  const canSubmit = mode === "picker" ? !!selected : manualValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "manual") {
      setTouched({ name: true, url: true, default_branch: true });
    }
    if (!canSubmit) return;

    setLoading(true);
    setServerError(null);

    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          default_branch: defaultBranch.trim(),
        }),
      });
      // Read as text first: an error response may have an empty/non-JSON body.
      const raw = await res.text();
      let data: {
        repository?: RepoRow;
        error?: string;
        errors?: Record<string, string>;
      } = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          // Non-JSON body — fall through to a status-based error below.
        }
      }
      if (!res.ok) {
        throw new Error(
          data.error ??
            (data.errors
              ? Object.values(data.errors).join("; ")
              : `Request failed (HTTP ${res.status})`)
        );
      }
      onAdded(data.repository!);
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : "Failed to add repository"
      );
    } finally {
      setLoading(false);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (mode !== "picker") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && results[highlight]) {
        e.preventDefault();
        selectRepo(results[highlight]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  const reconnectNeeded =
    listState === "error" &&
    (listError?.code === "github_not_connected" ||
      listError?.code === "github_reconnect");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-md rounded bg-[var(--gray-02)] border border-[var(--gray-05)] shadow-2xl p-6"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-4">
          Add repository
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {mode === "picker" ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs text-[var(--gray-10)]"
                htmlFor="repo-search"
              >
                Repository
              </label>

              {/* Combobox: input + results dropdown */}
              <div className="relative">
                <div className="relative">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--gray-08)]"
                  />
                  <input
                    id="repo-search"
                    type="text"
                    role="combobox"
                    aria-expanded={open}
                    aria-controls="repo-listbox"
                    aria-autocomplete="list"
                    autoComplete="off"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      if (selected) setSelected(null);
                      setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => {
                      // Delay so an option's mousedown/click registers first.
                      blurTimer.current = setTimeout(() => setOpen(false), 120);
                    }}
                    onKeyDown={onInputKeyDown}
                    placeholder="Search your GitHub repositories…"
                    className={`${INPUT_CLASS} pl-8 ${selected ? "pr-8" : ""}`}
                    autoFocus
                  />
                  {selected && (
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
                      aria-label="Clear selection"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                {open && (
                  <ul
                    id="repo-listbox"
                    role="listbox"
                    className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-[var(--gray-05)] bg-[var(--gray-01)] py-1 shadow-lg"
                    style={{ boxShadow: "var(--shadow-overlay)" }}
                  >
                    {listState === "loading" && (
                      <li className="flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--gray-09)]">
                        <Loader2 size={12} className="animate-spin" />
                        Loading repositories…
                      </li>
                    )}

                    {listState === "error" && (
                      <li className="px-3 py-2 text-xs text-[var(--red-11)]">
                        {reconnectNeeded
                          ? listError?.message
                          : `Couldn't load repositories: ${listError?.message}`}
                      </li>
                    )}

                    {listState === "loaded" && results.length === 0 && (
                      <li className="px-3 py-2 text-xs text-[var(--gray-08)]">
                        {query.trim()
                          ? "No repositories match your search."
                          : "No repositories found."}
                      </li>
                    )}

                    {listState === "loaded" &&
                      results.map((repo, i) => (
                        <li
                          key={repo.full_name}
                          role="option"
                          aria-selected={i === highlight}
                          // onMouseDown (not onClick) so selection lands before
                          // the input's onBlur closes the list.
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectRepo(repo);
                          }}
                          onMouseEnter={() => setHighlight(i)}
                          className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm ${
                            i === highlight
                              ? "bg-[var(--gray-03)]"
                              : "bg-transparent"
                          }`}
                        >
                          <span className="truncate font-mono text-[var(--gray-12)]">
                            {repo.full_name}
                          </span>
                          <VisibilityHint isPrivate={repo.private} />
                        </li>
                      ))}
                  </ul>
                )}
              </div>

              {/* Selected summary + branch confirmation */}
              {selected && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
                  <Check size={13} className="text-[var(--green-11)]" />
                  <span className="font-mono text-[var(--gray-11)]">
                    {selected.full_name}
                  </span>
                  <span className="text-[var(--gray-08)]">
                    · default branch{" "}
                    <span className="font-mono">{selected.default_branch}</span>
                  </span>
                </p>
              )}

              {reconnectNeeded && (
                <p className="text-xs text-[var(--gray-09)]">
                  {listError?.message} Or add it by hand below.
                </p>
              )}

              <button
                type="button"
                onClick={() => {
                  setMode("manual");
                  setOpen(false);
                }}
                className="mt-1 inline-flex items-center gap-1 self-start text-xs text-[var(--blue-11)] hover:underline"
              >
                <PenLine size={12} /> Enter manually
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--gray-09)]">
                  Enter the repository details by hand.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setMode("picker");
                    setOpen(true);
                  }}
                  className="inline-flex items-center gap-1 text-xs text-[var(--blue-11)] hover:underline"
                >
                  <Search size={12} /> Search instead
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs text-[var(--gray-10)]"
                  htmlFor="repo-name"
                >
                  Repository name
                </label>
                <input
                  id="repo-name"
                  type="text"
                  value={name}
                  onChange={(e) => handleManualNameChange(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  placeholder="e.g. bensigo/agentrail"
                  className={INPUT_CLASS}
                  autoFocus
                />
                {touched.name && nameError && (
                  <p className="text-xs text-[var(--red-11)]">{nameError}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs text-[var(--gray-10)]"
                  htmlFor="repo-url"
                >
                  GitHub URL
                </label>
                <input
                  id="repo-url"
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, url: true }))}
                  placeholder="https://github.com/owner/repo"
                  className={INPUT_CLASS}
                />
                {touched.url && urlError && (
                  <p className="text-xs text-[var(--red-11)]">{urlError}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs text-[var(--gray-10)]"
                  htmlFor="repo-branch"
                >
                  Default branch
                </label>
                <input
                  id="repo-branch"
                  type="text"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  onBlur={() =>
                    setTouched((t) => ({ ...t, default_branch: true }))
                  }
                  placeholder="main"
                  className={INPUT_CLASS}
                />
                {touched.default_branch && branchError && (
                  <p className="text-xs text-[var(--red-11)]">{branchError}</p>
                )}
              </div>
            </>
          )}

          {serverError && (
            <p className="text-xs text-[var(--red-11)]">{serverError}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="h-8 px-4 rounded bg-[var(--yellow-09)] text-black text-sm font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
            >
              {loading ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
