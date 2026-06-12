"use client";

import { useState, useEffect } from "react";

export interface FailureEvent {
  event_id: string;
  failure_type: string;
  phase: string;
  message: string;
  evidence: string;
  severity: string;
  occurred_at: string | Date;
}

interface FailuresResponse {
  failures: FailureEvent[];
}

function FailureRow({ failure }: { failure: FailureEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-[var(--gray-04)] last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--gray-02)] transition-colors"
      >
        <span
          title="Failure"
          style={{ color: "#ff9592" }}
          className="text-sm font-bold shrink-0"
          aria-label="Failure"
        >
          ✕
        </span>
        <span className="flex-1 text-sm text-[var(--gray-12)] truncate">
          {failure.message}
        </span>
        <span className="text-xs font-mono text-[var(--gray-09)] shrink-0">
          {failure.failure_type}
        </span>
        <span className="text-xs text-[var(--gray-08)] ml-2 shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-2">
          <div className="flex gap-4 text-xs font-mono text-[var(--gray-09)]">
            <span>
              phase: <span className="text-[var(--gray-11)]">{failure.phase}</span>
            </span>
            <span>
              severity: <span className="text-[var(--gray-11)]">{failure.severity}</span>
            </span>
          </div>

          {failure.evidence && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
                Evidence
              </p>
              <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 overflow-x-auto">
                <pre className="text-xs font-mono text-[var(--gray-11)] whitespace-pre-wrap break-words">
                  {failure.evidence}
                </pre>
              </div>
            </div>
          )}

          <p className="text-xs font-mono text-[var(--gray-09)]">
            {new Date(failure.occurred_at).toLocaleString("en-US", {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
          </p>
        </div>
      )}
    </div>
  );
}

interface FailuresSectionProps {
  workspaceId: string;
  runId: string;
}

export function FailuresSection({ workspaceId, runId }: FailuresSectionProps) {
  const [failures, setFailures] = useState<FailureEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/failures`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as FailuresResponse;
        setFailures(json.failures);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load failures");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <p className="text-sm text-[var(--gray-09)] animate-pulse py-4">
        Loading failures…
      </p>
    );
  }

  if (error) {
    return <p className="text-sm text-[#ff9592] py-4">{error}</p>;
  }

  if (failures.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-[#ff9592]">{failures.length} failure{failures.length !== 1 ? "s" : ""}</span>
      </div>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] overflow-hidden">
        {failures.map((f) => (
          <FailureRow key={f.event_id} failure={f} />
        ))}
      </div>
    </div>
  );
}
