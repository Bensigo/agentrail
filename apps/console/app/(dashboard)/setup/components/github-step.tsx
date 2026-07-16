"use client";

import { useState } from "react";
import { CheckCircle2, AlertTriangle, Copy } from "lucide-react";
import { AddRepositoryDialog } from "@/(dashboard)/dashboard/[workspaceId]/repos/components/add-repository-dialog";

interface RepoResult {
  repo: string;
  ok: boolean;
  error?: string;
}

interface WebhookResponse {
  ok: boolean;
  secret: string;
  results: RepoResult[];
  manual: { url: string; secret: string; contentType: string; events: string[] };
}

function CopyableSecret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-[var(--gray-09)]">{label}</span>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 truncate rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-1 font-mono text-xs text-[var(--gray-12)]">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[var(--gray-05)] text-[var(--gray-10)] hover:border-[var(--gray-08)] transition-colors"
          aria-label={`Copy ${label}`}
        >
          {copied ? <CheckCircle2 size={12} className="text-[var(--green-11)]" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

/** Manual "add it yourself" fallback, rendered on any GitHub API failure (AC2). */
function ManualInstructions({ manual }: { manual: WebhookResponse["manual"] }) {
  return (
    <div className="flex flex-col gap-2.5 rounded border border-[var(--orange-09)]/30 bg-[var(--orange-09)]/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--orange-11)]">
        <AlertTriangle size={13} /> Couldn&apos;t auto-create the webhook — add it manually
      </p>
      <ol className="ml-3.5 list-decimal space-y-1 text-xs leading-relaxed text-[var(--gray-10)]">
        <li>Open the repo on GitHub → Settings → Webhooks → Add webhook.</li>
        <li>Payload URL: the value below.</li>
        <li>Content type: <code className="font-mono">application/json</code>.</li>
        <li>Secret: the value below.</li>
        <li>Events: select just &quot;Issues&quot;.</li>
      </ol>
      <CopyableSecret label="Payload URL" value={manual.url} />
      <CopyableSecret label="Secret" value={manual.secret} />
    </div>
  );
}

export function GithubStep({
  workspaceId,
  repos,
  hasWebhookSecret,
  onChanged,
}: {
  workspaceId: string;
  repos: string[];
  hasWebhookSecret: boolean;
  onChanged: () => void;
}) {
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<WebhookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleAdded() {
    setShowAddDialog(false);
    onChanged();
  }

  async function handleCreateWebhook() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/connectors/github/webhook`,
        { method: "POST" }
      );
      const body = (await res.json()) as WebhookResponse | { error?: string };
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setResult(body as WebhookResponse);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create the webhook");
    } finally {
      setCreating(false);
    }
  }

  const failedRepos = result?.results.filter((r) => !r.ok) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Link the repositories Jace should work in, then create the webhook that
        lets labeled issues flow into the queue.
      </p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
          Repositories
        </span>
        {repos.length === 0 ? (
          <p className="text-xs text-[var(--gray-08)]">No repositories linked yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {repos.map((r) => (
              <li
                key={r}
                className="rounded-sm border border-[var(--gray-05)] bg-[var(--gray-02)] px-2 py-0.5 font-mono text-xs text-[var(--gray-11)]"
              >
                {r}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setShowAddDialog(true)}
          className="mt-1 h-8 self-start rounded border border-[var(--gray-06)] bg-[var(--gray-03)] px-3 text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Add repository
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-[var(--gray-04)] pt-3">
        {hasWebhookSecret && !result && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--gray-10)]">
            <CheckCircle2 size={13} className="text-[var(--green-11)]" />
            Webhook secret already configured.
          </p>
        )}
        <button
          type="button"
          onClick={handleCreateWebhook}
          disabled={repos.length === 0 || creating}
          className="h-8 self-start rounded bg-[var(--brand-accent)] px-3 text-xs font-medium text-black transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating
            ? "Creating…"
            : hasWebhookSecret
              ? "Recreate webhook"
              : "Create webhook automatically"}
        </button>
        {error && <p className="text-xs text-[var(--red-11)]">{error}</p>}
        {result && result.ok && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--green-11)]">
            <CheckCircle2 size={13} /> Webhook created on {result.results.length}{" "}
            {result.results.length === 1 ? "repository" : "repositories"}.
          </p>
        )}
        {result && failedRepos.length > 0 && (
          <>
            {failedRepos.map((r) => (
              <p key={r.repo} className="text-xs text-[var(--red-11)]">
                {r.repo}: {r.error}
              </p>
            ))}
            <ManualInstructions manual={result.manual} />
          </>
        )}
      </div>

      {showAddDialog && (
        <AddRepositoryDialog
          workspaceId={workspaceId}
          onAdded={handleAdded}
          onClose={() => setShowAddDialog(false)}
        />
      )}
    </div>
  );
}
