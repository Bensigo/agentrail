"use client";

import { useCallback, useEffect, useState } from "react";
import { Circle, AlertCircle } from "lucide-react";

interface HeartbeatConfigView {
  enabled: boolean;
  pollIntervalSeconds: number;
  triggerLabel: string;
  updatedAt: string | null;
}

type Role = "owner" | "admin" | "member" | string;

/**
 * The three capstone prerequisites the daemon requires before it can run,
 * mirroring REQUIRED_CAPABILITIES in agentrail/heartbeat/gate.py. The console
 * cannot import the Python gate; this is the static contract of what must be
 * present. The daemon enforces actual presence at runtime — enabling here is
 * operator intent, not a guarantee the loop runs.
 */
const REQUIRED_CAPABILITIES: { id: string; label: string; module: string }[] = [
  {
    id: "objective_gate",
    label: "Objective Gate",
    module: "agentrail/run/objective_gate.py",
  },
  {
    id: "budget_leash",
    label: "Budget Leash",
    module: "agentrail/run/budget_leash.py",
  },
  {
    id: "security_guardrail",
    label: "Security Guardrail",
    module: "agentrail/run/push_guardrail.py",
  },
];

// Non-terminal queue states count toward "depth" (work the heartbeat fed in
// that hasn't reached a terminal Green / Escalated / Blocked outcome).
const ACTIVE_QUEUE_STATES = new Set(["queued", "parked", "running"]);

export function HeartbeatPanel({ workspaceId }: { workspaceId: string }) {
  const [config, setConfig] = useState<HeartbeatConfigView | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [queueDepth, setQueueDepth] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, queueRes] = await Promise.all([
        fetch(`/api/v1/workspaces/${workspaceId}/heartbeat`),
        fetch(`/api/v1/workspaces/${workspaceId}/queue`),
      ]);
      if (!cfgRes.ok) {
        const body = await cfgRes.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? `HTTP ${cfgRes.status}`
        );
      }
      const cfgJson = (await cfgRes.json()) as {
        config: HeartbeatConfigView;
        role: Role;
      };
      setConfig(cfgJson.config);
      setRole(cfgJson.role);

      // Queue depth is best-effort — a queue read failure shouldn't blank the page.
      if (queueRes.ok) {
        const qJson = (await queueRes.json()) as {
          entries?: { state?: string }[];
        };
        const depth = (qJson.entries ?? []).filter((e) =>
          ACTIVE_QUEUE_STATES.has(String(e.state))
        ).length;
        setQueueDepth(depth);
      } else {
        setQueueDepth(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load heartbeat");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="h-56 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] animate-pulse" />
        <div className="h-56 rounded border border-[var(--gray-05)] bg-[var(--gray-01)] animate-pulse" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="rounded border border-[#e5484d]/30 bg-[#e5484d]/10 px-3 py-8 text-center text-sm text-[#ff9592]">
        {error ?? "No heartbeat config available."}
      </div>
    );
  }

  const canManage = role === "owner" || role === "admin";

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <StatusCard config={config} queueDepth={queueDepth} />
      <ControlsCard
        workspaceId={workspaceId}
        config={config}
        canManage={canManage}
        onSaved={load}
      />
    </div>
  );
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium ${
        enabled
          ? "bg-[#29a383]/15 text-[#1fd8a4]"
          : "bg-[var(--gray-04)] text-[var(--gray-10)]"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? "bg-[#1fd8a4]" : "bg-[var(--gray-08)]"
        }`}
      />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function StatusCard({
  config,
  queueDepth,
}: {
  config: HeartbeatConfigView;
  queueDepth: number | null;
}) {
  return (
    <div className="flex flex-col gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[var(--gray-12)]">
          Status
        </span>
        <StatusBadge enabled={config.enabled} />
      </div>

      {/* Trigger sentence — falsifiable: the exact label and cadence. */}
      <div className="rounded border border-[var(--gray-04)] bg-[var(--gray-01)] p-3">
        <p className="text-xs leading-relaxed text-[var(--gray-11)]">
          Polls GitHub for issues labeled{" "}
          <code className="font-mono text-[var(--gray-12)]">
            {config.triggerLabel}
          </code>{" "}
          every{" "}
          <code className="font-mono text-[var(--gray-12)]">
            {config.pollIntervalSeconds}s
          </code>
          .
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <dt className="text-[var(--gray-09)]">Queue depth (active)</dt>
        <dd className="text-right font-mono text-[var(--gray-12)]">
          {queueDepth === null ? "—" : queueDepth}
        </dd>
        <dt className="text-[var(--gray-09)]">Trigger label</dt>
        <dd className="truncate text-right font-mono text-[var(--gray-12)]">
          {config.triggerLabel}
        </dd>
        <dt className="text-[var(--gray-09)]">Poll interval</dt>
        <dd className="text-right font-mono text-[var(--gray-12)]">
          {config.pollIntervalSeconds}s
        </dd>
        <dt className="text-[var(--gray-09)]">Config updated</dt>
        <dd className="truncate text-right font-mono text-[var(--gray-11)]">
          {config.updatedAt
            ? new Date(config.updatedAt).toISOString().replace("T", " ").slice(0, 19)
            : "never"}
        </dd>
      </dl>

      {/* Prerequisite capabilities — all required before the daemon can run. */}
      <div className="border-t border-[var(--gray-04)] pt-3">
        <p className="mb-2 text-xs font-medium text-[var(--gray-10)]">
          Prerequisites (all required before the daemon runs)
        </p>
        <ul className="flex flex-col gap-1.5">
          {REQUIRED_CAPABILITIES.map((cap) => (
            <li key={cap.id} className="flex items-center gap-2 text-xs">
              <Circle
                size={14}
                className="shrink-0 text-[var(--gray-08)]"
                aria-hidden
              />
              <span className="text-[var(--gray-11)]">{cap.label}</span>
              <code className="ml-auto truncate font-mono text-[var(--gray-09)]">
                {cap.module}
              </code>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-[var(--gray-09)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          Presence is enforced by the daemon at runtime
          (agentrail/heartbeat/gate.py). Enabling here records intent only.
        </p>
      </div>
    </div>
  );
}

function ControlsCard({
  workspaceId,
  config,
  canManage,
  onSaved,
}: {
  workspaceId: string;
  config: HeartbeatConfigView;
  canManage: boolean;
  onSaved: () => void;
}) {
  const [interval, setIntervalValue] = useState(
    String(config.pollIntervalSeconds)
  );
  const [label, setLabel] = useState(config.triggerLabel);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    Number(interval) !== config.pollIntervalSeconds ||
    label.trim() !== config.triggerLabel;

  const put = useCallback(
    async (patch: Partial<HeartbeatConfigView>) => {
      setSaving(true);
      setErr(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/heartbeat`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        onSaved();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to save");
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, onSaved]
  );

  return (
    <div className="flex flex-col gap-4 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-4">
      <span className="text-sm font-semibold text-[var(--gray-12)]">
        Controls
      </span>

      {!canManage && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-[var(--gray-09)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          Read-only. Only a workspace owner or admin can change the heartbeat.
        </p>
      )}

      {/* Enabled toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-[var(--gray-11)]">Enabled</p>
          <p className="text-xs text-[var(--gray-09)]">
            {config.enabled ? "Heartbeat is on" : "Heartbeat is off"}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          disabled={!canManage || saving}
          onClick={() => put({ enabled: !config.enabled })}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            config.enabled ? "bg-[#29a383]" : "bg-[var(--gray-06)]"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
              config.enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(interval);
          put({ pollIntervalSeconds: n, triggerLabel: label.trim() });
        }}
        className="flex flex-col gap-3 border-t border-[var(--gray-04)] pt-3"
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="hb-interval"
            className="text-xs text-[var(--gray-09)]"
          >
            Poll interval (seconds, 10–86400)
          </label>
          <input
            id="hb-interval"
            type="number"
            min={10}
            max={86400}
            step={1}
            value={interval}
            disabled={!canManage}
            onChange={(e) => setIntervalValue(e.target.value)}
            className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-sm text-[var(--gray-12)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="hb-label" className="text-xs text-[var(--gray-09)]">
            Trigger label
          </label>
          <input
            id="hb-label"
            type="text"
            maxLength={50}
            value={label}
            disabled={!canManage}
            placeholder="ready-for-agent"
            onChange={(e) => setLabel(e.target.value)}
            className="h-8 w-full rounded border border-[var(--gray-05)] bg-[var(--gray-01)] px-2 font-mono text-sm text-[var(--gray-12)] placeholder:text-[var(--gray-07)] outline-none focus:border-[var(--gray-08)] disabled:opacity-50"
          />
        </div>

        <button
          type="submit"
          disabled={!canManage || saving || !dirty || !label.trim()}
          className="h-8 w-full rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-sm font-medium text-[var(--gray-12)] transition-colors hover:border-[var(--gray-08)] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save trigger"}
        </button>
        {err && <p className="text-xs text-[#ff9592]">{err}</p>}
      </form>
    </div>
  );
}
