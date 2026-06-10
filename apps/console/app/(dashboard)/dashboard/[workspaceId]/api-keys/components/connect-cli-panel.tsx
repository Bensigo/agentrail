"use client";

import { useEffect, useState } from "react";
import { Copy, Check, Terminal } from "lucide-react";

interface Repo {
  id: string;
  name: string;
}

interface ConnectCliPanelProps {
  workspaceId: string;
  secret: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={handleCopy}
      className="flex-shrink-0 flex items-center gap-1 h-6 px-2 rounded bg-[var(--gray-04)] border border-[var(--gray-06)] text-xs text-[var(--gray-11)] hover:border-[var(--gray-08)] transition-colors"
      aria-label="Copy"
    >
      {copied ? (
        <Check size={11} className="text-[#1fd8a4]" />
      ) : (
        <Copy size={11} />
      )}
    </button>
  );
}

export function ConnectCliPanel({ workspaceId, secret }: ConnectCliPanelProps) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/repos`)
      .then((r) => r.json())
      .then((data: { repos?: Repo[] }) => {
        const list = data.repos ?? [];
        setRepos(list);
        if (list.length > 0) setRepoId(list[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const snippet = `agentrail link --workspace ${workspaceId} --repo ${repoId || "<repo_id>"} --key ${secret}`;

  return (
    <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Terminal size={14} className="text-[var(--gray-09)]" />
        <span className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide">
          Connect CLI
        </span>
      </div>

      {/* Workspace ID row */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--gray-09)]">Workspace ID</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs text-[var(--gray-11)] bg-[var(--gray-03)] border border-[var(--gray-05)] rounded px-2 py-1 truncate">
            {workspaceId}
          </code>
          <CopyButton text={workspaceId} />
        </div>
      </div>

      {/* Repo selector */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--gray-09)]">Repository</span>
        {loading ? (
          <div className="h-8 rounded bg-[var(--gray-03)] border border-[var(--gray-05)] animate-pulse" />
        ) : repos.length === 0 ? (
          <p className="text-xs text-[var(--gray-09)]">
            No repositories found in this workspace.
          </p>
        ) : (
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="h-8 rounded bg-[var(--gray-02)] border border-[var(--gray-05)] px-2 text-xs text-[var(--gray-12)] font-mono focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-1 focus:ring-offset-[var(--gray-02)]"
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.id})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Command snippet */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-[var(--gray-09)]">Run in your terminal</span>
        <div className="flex items-start gap-2">
          <code className="flex-1 font-mono text-xs text-[#1fd8a4] bg-[var(--gray-03)] border border-[var(--gray-05)] rounded px-2 py-2 break-all leading-relaxed">
            {snippet}
          </code>
          <CopyButton text={snippet} />
        </div>
      </div>

      {/* Secret warning */}
      <p className="text-xs text-[#ffa057] bg-[#f76b15]/10 border border-[#f76b15]/30 rounded px-3 py-1.5">
        This secret will not be shown again after you leave this page.
      </p>
    </div>
  );
}
