"use client";

import { useState } from "react";
import { Copy, Check, X } from "lucide-react";

interface CreateKeyDialogProps {
  workspaceId: string;
  onCreated: (key: ApiKeyRow) => void;
  onClose: () => void;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  team_id: string | null;
  created_at: string;
  last_used_at: string | null;
  is_revoked: boolean;
  revoked_at: string | null;
}

export function CreateKeyDialog({
  workspaceId,
  onCreated,
  onClose,
}: CreateKeyDialogProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/api-keys`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }
      );
      const body = await res.json() as { api_key?: ApiKeyRow; secret?: string; error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSecret(body.secret ?? null);
      onCreated(body.api_key!);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (!secret) return;
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-md rounded bg-[var(--gray-02)] border border-[var(--gray-05)] shadow-2xl p-6"
        style={{ boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-4">
          Create API Key
        </h2>

        {!secret ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-[var(--gray-10)]" htmlFor="key-name">
                Name
              </label>
              <input
                id="key-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. CI deployment key"
                className="h-8 rounded bg-[var(--gray-01)] border border-[var(--gray-05)] px-3 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-02)]"
                autoFocus
              />
            </div>

            {error && (
              <p className="text-xs text-[#ff9592]">{error}</p>
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
                disabled={loading || !name.trim()}
                className="h-8 px-4 rounded bg-[#ffe629] text-black text-sm font-medium hover:bg-[#ffdc00] disabled:opacity-50 transition-colors"
              >
                {loading ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded bg-[var(--gray-03)] border border-[var(--gray-05)] p-3 flex flex-col gap-2">
              <p className="text-xs font-medium text-[var(--gray-11)]">
                Your new API key
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs text-[#1fd8a4] break-all">
                  {secret}
                </code>
                <button
                  onClick={handleCopy}
                  className="flex-shrink-0 flex items-center gap-1.5 h-7 px-2.5 rounded bg-[var(--gray-04)] border border-[var(--gray-06)] text-xs text-[var(--gray-11)] hover:border-[var(--gray-08)] transition-colors"
                >
                  {copied ? (
                    <><Check size={12} className="text-[#1fd8a4]" /> Copied</>
                  ) : (
                    <><Copy size={12} /> Copy</>
                  )}
                </button>
              </div>
            </div>

            <p className="text-xs text-[#ffa057] bg-[#f76b15]/10 border border-[#f76b15]/30 rounded px-3 py-2">
              This key will not be shown again. Copy it now and store it securely.
            </p>

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="h-8 px-4 rounded bg-[#ffe629] text-black text-sm font-medium hover:bg-[#ffdc00] transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
