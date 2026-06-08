"use client";

import { useEffect, useState, useCallback } from "react";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  isRevoked: boolean;
}

export function ApiKeysList({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const fetchKeys = useCallback(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/api-keys`)
      .then((r) => r.json())
      .then((data) => {
        setKeys(data.keys ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    const data = await res.json();
    if (data.key?.secret) {
      setCreatedSecret(data.key.secret);
      setNewName("");
      fetchKeys();
    }
  };

  const handleRevoke = async (keyId: string) => {
    await fetch(`/api/v1/workspaces/${workspaceId}/api-keys/${keyId}`, {
      method: "DELETE",
    });
    setRevoking(null);
    fetchKeys();
  };

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-4">
      {canManage && (
        <div className="mb-4">
          {createdSecret ? (
            <div className="rounded border border-[#f5d90a]/30 bg-[#f5d90a]/10 p-4">
              <p className="text-sm font-medium text-[var(--gray-12)]">
                {"Key created. Copy it now — it won’t be shown again."}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded bg-[var(--gray-02)] px-3 py-2 font-mono text-xs text-[var(--gray-12)]">
                  {createdSecret}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(createdSecret);
                  }}
                  className="rounded-sm bg-[var(--brand-accent)] px-3 py-1.5 text-xs font-medium text-[var(--gray-00)]"
                >
                  Copy
                </button>
              </div>
              <button
                onClick={() => {
                  setCreatedSecret(null);
                  setShowCreate(false);
                }}
                className="mt-2 text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)]"
              >
                Dismiss
              </button>
            </div>
          ) : showCreate ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Key name"
                className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 py-1.5 text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-07)]"
              />
              <button
                onClick={handleCreate}
                className="rounded-sm bg-[var(--brand-accent)] px-3 py-1.5 text-xs font-medium text-[var(--gray-00)]"
              >
                Create
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className="text-xs text-[var(--gray-09)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-sm bg-[var(--brand-accent)] px-3 py-1.5 text-xs font-medium text-[var(--gray-00)]"
            >
              Create API Key
            </button>
          )}
        </div>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-[var(--gray-09)]">No API keys found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Last Used</th>
                <th className="px-3 py-2">Status</th>
                {canManage && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]">
                  <td className="px-3 py-2 text-sm text-[var(--gray-12)]">{key.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-11)]">
                    {key.keyPrefix}••••••••
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                    {new Date(key.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                    {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : "Never"}
                  </td>
                  <td className="px-3 py-2">
                    {key.isRevoked ? (
                      <span className="rounded-sm bg-[#e5484d]/20 px-1.5 py-0.5 text-xs text-[#e5484d]">
                        Revoked
                      </span>
                    ) : (
                      <span className="rounded-sm bg-[#29a383]/20 px-1.5 py-0.5 text-xs text-[#29a383]">
                        Active
                      </span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2">
                      {!key.isRevoked &&
                        (revoking === key.id ? (
                          <span className="flex items-center gap-2">
                            <button
                              onClick={() => handleRevoke(key.id)}
                              className="rounded-sm bg-[#e5484d] px-2 py-1 text-xs text-white"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRevoking(null)}
                              className="text-xs text-[var(--gray-09)]"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setRevoking(key.id)}
                            className="text-xs text-[#e5484d] hover:underline"
                          >
                            Revoke
                          </button>
                        ))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
