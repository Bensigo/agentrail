"use client";

import { useState, useEffect } from "react";

export interface EvidenceRef {
  label: string;
  url: string;
}

export interface ReviewGate {
  id: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions: Record<string, unknown>[];
  blockingReasons: string[];
  evidenceRefs: EvidenceRef[];
  evaluatedAt: string | null;
}

interface ReviewGatesResponse {
  gates: ReviewGate[];
}

function StatusIcon({ status }: { status: ReviewGate["status"] }) {
  if (status === "passed") {
    return (
      <span
        title="Passed"
        style={{ color: "#1fd8a4" }}
        className="text-sm font-bold shrink-0"
        aria-label="Passed"
      >
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title="Failed"
        style={{ color: "#ff9592" }}
        className="text-sm font-bold shrink-0"
        aria-label="Failed"
      >
        ✕
      </span>
    );
  }
  return (
    <span
      title="Pending"
      style={{ color: "#f5e147" }}
      className="text-sm shrink-0"
      aria-label="Pending"
    >
      ⏱
    </span>
  );
}

function StatusBadge({ status }: { status: ReviewGate["status"] }) {
  const styles: Record<ReviewGate["status"], string> = {
    passed: "bg-[#1a3d33] text-[#1fd8a4]",
    failed: "bg-[#3d1a1a] text-[#ff9592]",
    pending: "bg-[#3d3a1a] text-[#f5e147]",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function GateRow({ gate }: { gate: ReviewGate }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-[var(--gray-04)] last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--gray-02)] transition-colors group"
      >
        <StatusIcon status={gate.status} />
        <span className="flex-1 text-sm text-[var(--gray-12)]">
          {gate.gateName}
        </span>
        <StatusBadge status={gate.status} />
        <span className="text-xs text-[var(--gray-08)] ml-2 shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-3">
          {gate.conditions.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
                Conditions
              </p>
              <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] p-3 overflow-x-auto">
                <pre className="text-xs font-mono text-[var(--gray-11)] whitespace-pre-wrap break-words">
                  {JSON.stringify(gate.conditions, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {gate.blockingReasons.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
                Blocking reasons
              </p>
              <ul className="space-y-1">
                {gate.blockingReasons.map((reason, i) => (
                  <li
                    key={i}
                    className="text-xs font-mono text-[#ff9592] flex items-start gap-1.5"
                  >
                    <span className="mt-0.5 shrink-0">✕</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {gate.evidenceRefs.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] mb-1">
                Evidence
              </p>
              <div className="flex flex-wrap gap-2">
                {gate.evidenceRefs.map((ref, i) => (
                  <a
                    key={i}
                    href={ref.url}
                    className="text-xs text-[#70b8ff] hover:underline font-mono"
                  >
                    {ref.label} →
                  </a>
                ))}
              </div>
            </div>
          )}

          {gate.evaluatedAt && (
            <p className="text-xs font-mono text-[var(--gray-09)]">
              Evaluated:{" "}
              {new Date(gate.evaluatedAt).toLocaleString("en-US", {
                month: "short",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              })}
            </p>
          )}

          {gate.conditions.length === 0 &&
            gate.blockingReasons.length === 0 &&
            gate.evidenceRefs.length === 0 &&
            !gate.evaluatedAt && (
              <p className="text-xs text-[var(--gray-09)]">
                No details available.
              </p>
            )}
        </div>
      )}
    </div>
  );
}

interface ReviewGatesSectionProps {
  workspaceId: string;
  runId: string;
}

export function ReviewGatesSection({
  workspaceId,
  runId,
}: ReviewGatesSectionProps) {
  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/review-gates`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as ReviewGatesResponse;
        setGates(json.gates);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load review gates");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <p className="text-sm text-[var(--gray-09)] animate-pulse py-4">
        Loading review gates…
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-[#ff9592] py-4">{error}</p>
    );
  }

  if (gates.length === 0) {
    return (
      <p className="text-sm text-[var(--gray-09)] py-4">
        No review gates recorded for this run.
      </p>
    );
  }

  const passed = gates.filter((g) => g.status === "passed").length;
  const failed = gates.filter((g) => g.status === "failed").length;
  const pending = gates.filter((g) => g.status === "pending").length;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        {passed > 0 && (
          <span className="text-xs text-[#1fd8a4]">{passed} passed</span>
        )}
        {failed > 0 && (
          <span className="text-xs text-[#ff9592]">{failed} failed</span>
        )}
        {pending > 0 && (
          <span className="text-xs text-[#f5e147]">{pending} pending</span>
        )}
      </div>
      <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] overflow-hidden">
        {gates.map((gate) => (
          <GateRow key={gate.id} gate={gate} />
        ))}
      </div>
    </div>
  );
}
