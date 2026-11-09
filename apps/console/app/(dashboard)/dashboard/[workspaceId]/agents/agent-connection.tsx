"use client";
import { useState } from "react";

export function AgentConnection({
  workspaceId,
  canManage,
  consoleOrigin,
}: {
  workspaceId: string;
  canManage: boolean;
  consoleOrigin: string;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revoked, setRevoked] = useState(false);
  async function create() {
    setPending(true);
    setError("");
    try {
      const res = await fetch(
        `/api/v1/workflow/keys?workspaceId=${workspaceId}`,
        { method: "POST" },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not create key");
      setSecret(body.secret);
      setKeyId(body.id);
      setRevoked(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setPending(false);
    }
  }
  async function revoke() {
    setPending(true);
    setError("");
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/api-keys/${keyId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Could not revoke key");
      setSecret(null);
      setRevoked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revocation failed");
    } finally {
      setPending(false);
    }
  }
  const config = {
    mcpServers: {
      agentrail: {
        command: "node",
        args: ["/absolute/path/to/agentrail/packages/mcp/dist/index.js"],
        env: {
          AGENTRAIL_BIN: "/absolute/path/to/agentrail/.venv/bin/agentrail",
          AGENTRAIL_TARGET: "/absolute/path/to/your/project",
          AGENTRAIL_WORKFLOW_BASE_URL: consoleOrigin,
          AGENTRAIL_WORKFLOW_API_KEY: secret || "<your-workflow-key>",
        },
      },
    },
  };
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-[var(--gray-11)]">
        Connect any MCP-compatible coding agent. Use these command, arguments
        and environment values in your client’s MCP settings.
      </p>
      <p className="text-sm text-[var(--gray-09)]">
        Build the MCP server first with{" "}
        <code>pnpm --filter @agentrail/mcp build</code>. Set the absolute paths
        for your machine.
      </p>
      {canManage && !secret && (
        <button
          disabled={pending}
          onClick={create}
          className="self-start rounded bg-[var(--brand-accent)] px-4 py-2 text-sm text-[var(--accent-fill-text)] disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create workflow key"}
        </button>
      )}
      {!canManage && <p>An owner or admin can create your workflow key.</p>}
      {secret && (
        <p className="text-sm">
          Save this key now. It is shown once and allows workflow reads and
          reports in this workspace.
        </p>
      )}
      <pre className="overflow-auto rounded-lg border border-[var(--gray-05)] bg-[var(--gray-02)] p-4 text-xs">
        {JSON.stringify(config, null, 2)}
      </pre>
      {secret && (
        <button
          disabled={pending}
          onClick={revoke}
          className="self-start rounded border border-[var(--gray-06)] px-3 py-2 text-sm"
        >
          Revoke this key
        </button>
      )}
      {revoked && <p role="status">Key revoked.</p>}
      {error && <p role="alert">{error}</p>}
      <p className="text-sm text-[var(--gray-09)]">
        Ask your agent to list repositories, start a task and report its
        progress. Agent reports appear in Work. Checks and completion reports
        remain labelled as reported; you make the final decision.
      </p>
    </section>
  );
}
