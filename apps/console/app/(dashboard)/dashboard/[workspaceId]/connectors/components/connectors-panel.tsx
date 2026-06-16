"use client";

import { useCallback, useEffect, useState } from "react";
import { Github, Layers, MessageSquare } from "lucide-react";
import { ConnectorStatusBadge } from "./connector-status-badge";
import {
  capabilitySummary,
  type ConnectorKind,
  type ConnectorView,
} from "./connector-helpers";

const KIND_ICON: Record<ConnectorKind, typeof Github> = {
  github: Github,
  linear: Layers,
  discord: MessageSquare,
};

function ConnectorCard({
  connector,
  workspaceId,
  onChanged,
}: {
  connector: ConnectorView;
  workspaceId: string;
  onChanged: () => void;
}) {
  const Icon = KIND_ICON[connector.kind];
  const isPlanned = connector.availability === "planned";
  const isConnected = connector.status === "connected";

  return (
    <div className="flex flex-col gap-3 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[var(--gray-03)] border border-[var(--gray-05)]">
          <Icon size={18} className="text-[var(--gray-11)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--gray-12)]">
              {connector.label}
            </span>
            <ConnectorStatusBadge
              status={connector.status}
              availability={connector.availability}
            />
          </div>
          <p className="mt-0.5 text-xs text-[var(--gray-09)] leading-relaxed">
            {connector.description}
          </p>
        </div>
      </div>

      {/* Capabilities + binding details */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-[var(--gray-09)]">Capabilities</dt>
        <dd className="font-mono text-[var(--gray-11)] text-right">
          {capabilitySummary(connector.capabilities)}
        </dd>
        {isConnected && connector.ingestLabel && (
          <>
            <dt className="text-[var(--gray-09)]">Ingest label</dt>
            <dd className="font-mono text-[var(--gray-11)] text-right truncate">
              {connector.ingestLabel}
            </dd>
          </>
        )}
        {isConnected && connector.target && (
          <>
            <dt className="text-[var(--gray-09)]">Target</dt>
            <dd className="font-mono text-[var(--gray-11)] text-right truncate">
              {connector.target}
            </dd>
          </>
        )}
      </dl>

      {/* Action / status footer */}
      <div className="mt-auto border-t border-[var(--gray-04)] pt-3">
        {connector.kind === "discord" ? (
          <DiscordManage
            connector={connector}
            workspaceId={workspaceId}
            onChanged={onChanged}
          />
        ) : isPlanned ? (
          <button
            disabled
            className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] text-xs font-medium text-[var(--gray-08)] cursor-not-allowed"
            title="Adapter ships in a follow-up (M038)"
          >
            Coming soon
          </button>
        ) : isConnected ? (
          <p className="text-xs text-[var(--gray-09)] leading-relaxed">
            Connected via the workspace&apos;s linked repositories. Issues labeled{" "}
            <code className="font-mono text-[var(--gray-11)]">
              {connector.ingestLabel}
            </code>{" "}
            are ingested into the Issue Queue; run results post back on the issue.
          </p>
        ) : (
          <p className="text-xs text-[var(--gray-09)] leading-relaxed">
            Not connected. Link a repository to this workspace (API Keys → Connect
            CLI) to ingest its labeled issues into the Issue Queue.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Discord notify-connector management (M038, AC3). Lets a team connect /
 * disconnect Discord by saving a channel webhook URL — the connector posts
 * completion and escalation-to-human notifications to it (the Python adapter is
 * agentrail/connectors/discord.py). The full webhook is write-only: the read
 * model returns only a masked target, so we never render the secret token.
 */
function DiscordManage({
  connector,
  workspaceId,
  onChanged,
}: {
  connector: ConnectorView;
  workspaceId: string;
  onChanged: () => void;
}) {
  const isConnected = connector.status === "connected";
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(
    async (url: string | null) => {
      setSaving(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/connectors/discord`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ webhookUrl: url }),
          }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        setWebhookUrl("");
        onChanged();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save webhook");
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, onChanged]
  );

  if (isConnected) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-[var(--gray-09)] leading-relaxed">
          Connected. Run <strong>completion</strong> and{" "}
          <strong>escalation-to-human</strong> notifications post to{" "}
          <code className="font-mono text-[var(--gray-11)]">
            {connector.target ?? "the configured webhook"}
          </code>
          .
        </p>
        <button
          onClick={() => save(null)}
          disabled={saving}
          className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-02)] text-xs font-medium text-[var(--gray-11)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
        >
          {saving ? "Disconnecting…" : "Disconnect"}
        </button>
        {err && <p className="text-xs text-[#ff9592]">{err}</p>}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (webhookUrl.trim()) save(webhookUrl.trim());
      }}
      className="flex flex-col gap-2"
    >
      <label className="text-xs text-[var(--gray-09)]" htmlFor="discord-webhook">
        Channel webhook URL
      </label>
      <input
        id="discord-webhook"
        type="url"
        inputMode="url"
        placeholder="https://discord.com/api/webhooks/…"
        value={webhookUrl}
        onChange={(e) => setWebhookUrl(e.target.value)}
        className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 text-xs font-mono text-[var(--gray-12)] placeholder:text-[var(--gray-07)] focus:border-[var(--gray-08)] outline-none"
      />
      <button
        type="submit"
        disabled={saving || !webhookUrl.trim()}
        className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-xs font-medium text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors disabled:opacity-50"
      >
        {saving ? "Connecting…" : "Connect"}
      </button>
      {err && <p className="text-xs text-[#ff9592]">{err}</p>}
    </form>
  );
}

export function ConnectorsPanel({ workspaceId }: { workspaceId: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/workspaces/${workspaceId}/connectors`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${res.status}`
        );
      }
      const json = (await res.json()) as { connectors: ConnectorView[] };
      setConnectors(json.connectors ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center">
        <button
          onClick={fetchConnectors}
          className="ml-auto h-8 px-3 rounded bg-[var(--gray-03)] border border-[var(--gray-06)] text-sm text-[var(--gray-12)] hover:border-[var(--gray-08)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 px-3 py-8 text-center text-sm text-[#ff9592]">
          {error}
        </div>
      ) : connectors.length === 0 ? (
        <div className="rounded border border-[var(--gray-05)] px-3 py-8 text-center text-sm text-[var(--gray-09)]">
          No connectors available.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.kind}
              connector={c}
              workspaceId={workspaceId}
              onChanged={fetchConnectors}
            />
          ))}
        </div>
      )}
    </div>
  );
}
