"use client";

import { useState } from "react";
import { Check } from "lucide-react";

/**
 * Client form for the runner activation page. Submits the operator-entered
 * `user_code` to the session-authenticated approve route and shows the outcome.
 */
export function ActivateForm() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ workspaceName: string } | null>(
    null
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/auth/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: trimmed }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        workspace_name?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setApproved({ workspaceName: body.workspace_name ?? "your workspace" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve runner");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="w-full max-w-md rounded bg-[var(--gray-02)] border border-[var(--gray-05)] p-6"
      style={{ boxShadow: "var(--shadow-overlay)" }}
    >
      <h1 className="text-base font-semibold text-[var(--gray-12)] mb-1">
        Authorize a runner
      </h1>
      <p className="text-xs text-[var(--gray-10)] mb-5">
        Enter the code shown by your self-hosted runner to connect it to this
        workspace.
      </p>

      {!approved ? (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-[var(--gray-10)]" htmlFor="user-code">
              Device code
            </label>
            <input
              id="user-code"
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="WDJB-MJHT"
              autoComplete="off"
              spellCheck={false}
              className="h-9 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 font-mono text-sm tracking-widest text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[var(--yellow-09)] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
              autoFocus
            />
          </div>

          {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}

          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="h-9 px-4 rounded bg-[var(--yellow-09)] text-black text-sm font-medium hover:bg-[var(--yellow-09-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? "Authorizing…" : "Authorize runner"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[var(--gray-12)]">
            <Check size={16} className="text-[var(--green-11)]" />
            <span className="text-sm font-medium">Runner authorized</span>
          </div>
          <p className="text-xs text-[var(--gray-10)]">
            Connected to{" "}
            <span className="text-[var(--gray-12)]">
              {approved.workspaceName}
            </span>
            . You can return to your terminal — the runner will pick up its token
            on its next poll.
          </p>
        </div>
      )}
    </div>
  );
}
