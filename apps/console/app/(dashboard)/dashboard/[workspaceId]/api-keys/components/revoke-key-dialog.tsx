"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface RevokeKeyDialogProps {
  workspaceId: string;
  keyId: string;
  keyName: string;
  onRevoked: (keyId: string) => void;
  onClose: () => void;
}

export function RevokeKeyDialog({
  workspaceId,
  keyId,
  keyName,
  onRevoked,
  onClose,
}: RevokeKeyDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRevoke() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/api-keys/${keyId}`,
        { method: "DELETE" }
      );
      const body = await res.json() as { success?: boolean; error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onRevoked(keyId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-sm rounded bg-[var(--gray-02)] border border-[var(--gray-05)] shadow-2xl p-6"
        style={{ boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-2">
          Revoke API Key
        </h2>
        <p className="text-sm text-[var(--gray-10)] mb-4">
          Revoke{" "}
          <span className="font-medium text-[var(--gray-12)]">{keyName}</span>?
          Any requests using this key will immediately stop working.
        </p>

        {error && (
          <p className="text-xs text-[#ff9592] mb-3">{error}</p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRevoke}
            disabled={loading}
            className="h-8 px-4 rounded bg-[#e5484d] text-white text-sm font-medium hover:bg-[#ce2c31] disabled:opacity-50 transition-colors"
          >
            {loading ? "Revoking…" : "Revoke key"}
          </button>
        </div>
      </div>
    </div>
  );
}
