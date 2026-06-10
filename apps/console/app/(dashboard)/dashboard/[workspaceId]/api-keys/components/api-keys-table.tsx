"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateKeyDialog, type ApiKeyRow } from "./create-key-dialog";
import { RevokeKeyDialog } from "./revoke-key-dialog";
import { ConnectCliPanel } from "./connect-cli-panel";

interface ApiKeysTableProps {
  workspaceId: string;
  initialKeys: ApiKeyRow[];
  canManage: boolean;
}

function maskKey(prefix: string): string {
  return `${prefix}…****`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function ApiKeysTable({
  workspaceId,
  initialKeys,
  canManage,
}: ApiKeysTableProps) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [showCreate, setShowCreate] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);

  function handleCreated(newKey: ApiKeyRow, secret: string) {
    setKeys((prev) => [newKey, ...prev]);
    setNewKeySecret(secret);
  }

  function handleRevoked(keyId: string) {
    setKeys((prev) =>
      prev.map((k) =>
        k.id === keyId
          ? { ...k, is_revoked: true, revoked_at: new Date().toISOString() }
          : k
      )
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {canManage && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 h-8 px-3 rounded bg-[#ffe629] text-black text-sm font-medium hover:bg-[#ffdc00] transition-colors"
          >
            <Plus size={14} />
            New key
          </button>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-sm text-[var(--gray-09)]">
          No API keys yet.{" "}
          {canManage && (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-2 text-[#70b8ff] hover:underline"
            >
              Create your first key.
            </button>
          )}
        </div>
      ) : (
        <div className="rounded border border-[var(--gray-05)] overflow-hidden">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-[var(--gray-05)] bg-[var(--gray-01)]">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Name
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Key
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Created
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                  Last used
                </th>
                {canManage && (
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className="border-b border-[var(--gray-04)] hover:bg-[var(--gray-02)] transition-colors"
                  style={{ height: "36px" }}
                >
                  <td className="px-3 py-1.5">
                    {key.is_revoked ? (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[var(--gray-04)] text-[var(--gray-09)] border border-[var(--gray-06)]">
                        revoked
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[#29a383]/20 text-[#1fd8a4] border border-[#29a383]/30">
                        active
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="text-[var(--gray-12)] text-xs font-medium">
                      {key.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <code className="font-mono text-xs text-[var(--gray-10)]">
                      {maskKey(key.key_prefix)}
                    </code>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-10)]">
                      {formatDate(key.created_at)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono text-xs text-[var(--gray-09)]">
                      {key.last_used_at ? formatDate(key.last_used_at) : "—"}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-3 py-1.5">
                      {!key.is_revoked && (
                        <button
                          onClick={() => setRevokeTarget(key)}
                          className="h-7 px-2.5 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-xs text-[#ff9592] hover:border-[#e5484d]/50 transition-colors"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {newKeySecret && (
        <ConnectCliPanel workspaceId={workspaceId} secret={newKeySecret} />
      )}

      {showCreate && (
        <CreateKeyDialog
          workspaceId={workspaceId}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}

      {revokeTarget && (
        <RevokeKeyDialog
          workspaceId={workspaceId}
          keyId={revokeTarget.id}
          keyName={revokeTarget.name}
          onRevoked={handleRevoked}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}
