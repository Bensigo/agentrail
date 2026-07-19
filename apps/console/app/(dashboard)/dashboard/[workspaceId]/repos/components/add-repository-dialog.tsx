"use client";

import { useState } from "react";
import { X } from "lucide-react";

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

interface AddRepositoryDialogProps {
  workspaceId: string;
  onAdded: (repo: RepoRow) => void;
  onClose: () => void;
}

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_UNSAFE_RE = /[\x00-\x1f\x7f ~^:?*[\\\s]|\.\.|\.lock$|\/$/ ;

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

export function AddRepositoryDialog({
  workspaceId,
  onAdded,
  onClose,
}: AddRepositoryDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [touched, setTouched] = useState({ name: false, url: false, default_branch: false });
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const nameError = validateName(name);
  const urlError = validateUrl(url, name);
  const branchError = validateBranch(defaultBranch);
  const isValid = !nameError && !urlError && !branchError;

  // Auto-fill URL when name looks valid
  function handleNameChange(val: string) {
    setName(val);
    if (REPO_NAME_RE.test(val.trim()) && !url) {
      setUrl(`https://github.com/${val.trim()}`);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ name: true, url: true, default_branch: true });
    if (!isValid) return;

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
      // Read the body as text first: error responses (e.g. an unhandled 500)
      // may have an empty or non-JSON body, which would otherwise make
      // res.json() throw a cryptic "Unexpected end of JSON input".
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
          // Non-JSON body — fall through to a status-based error message below.
        }
      }
      if (!res.ok) {
        throw new Error(
          data.error ??
            (data.errors ? Object.values(data.errors).join("; ") : `Request failed (HTTP ${res.status})`)
        );
      }
      onAdded(data.repository!);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Failed to add repository");
    } finally {
      setLoading(false);
    }
  }

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
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="repo-name">
              Repository name
            </label>
            <input
              id="repo-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              placeholder="e.g. bensigo/agentrail"
              className="h-8 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
              autoFocus
            />
            {touched.name && nameError && (
              <p className="text-xs text-[var(--red-11)]">{nameError}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="repo-url">
              GitHub URL
            </label>
            <input
              id="repo-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, url: true }))}
              placeholder="https://github.com/owner/repo"
              className="h-8 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
            />
            {touched.url && urlError && (
              <p className="text-xs text-[var(--red-11)]">{urlError}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="repo-branch">
              Default branch
            </label>
            <input
              id="repo-branch"
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, default_branch: true }))}
              placeholder="main"
              className="h-8 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
            />
            {touched.default_branch && branchError && (
              <p className="text-xs text-[var(--red-11)]">{branchError}</p>
            )}
          </div>

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
              disabled={loading || (touched.name && touched.url && touched.default_branch && !isValid)}
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
