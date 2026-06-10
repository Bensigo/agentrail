"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";

interface EvidenceRef {
  label: string;
  url: string;
}

interface ReviewGate {
  id: string;
  runId: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions: Record<string, unknown>[];
  blockingReasons: string[];
  evidenceRefs: EvidenceRef[];
  evaluatedAt: string | null;
}

function StatusIcon({ status }: { status: ReviewGate["status"] }) {
  if (status === "passed") {
    return (
      <span style={{ color: "#1fd8a4" }} className="text-sm font-bold shrink-0" aria-label="Passed">
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span style={{ color: "#ff9592" }} className="text-sm font-bold shrink-0" aria-label="Failed">
        ✕
      </span>
    );
  }
  return (
    <span style={{ color: "#f5e147" }} className="text-sm shrink-0" aria-label="Pending">
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
    <span className={`px-1.5 py-0.5 rounded-sm text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function GateRow({ gate, workspaceId }: { gate: ReviewGate; workspaceId: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-[var(--gray-04)] last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--gray-02)] transition-colors"
      >
        <StatusIcon status={gate.status} />
        <div className="flex-1 min-w-0">
          <span className="text-sm text-[var(--gray-12)]">{gate.gateName}</span>
          <span className="ml-2 font-mono text-xs text-[var(--gray-09)]">
            run:{gate.runId.slice(0, 8)}
          </span>
        </div>
        <StatusBadge status={gate.status} />
        <a
          href={`/dashboard/${workspaceId}/runs/${gate.runId}`}
          onClick={(e) => e.stopPropagation()}
          className="text-xs text-[#70b8ff] hover:underline ml-2 shrink-0"
        >
          run →
        </a>
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
                  <li key={i} className="text-xs font-mono text-[#ff9592] flex items-start gap-1.5">
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
                  <a key={i} href={ref.url} className="text-xs text-[#70b8ff] hover:underline font-mono">
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
        </div>
      )}
    </div>
  );
}

export default function ReviewGatesPage() {
  const params = useParams<{ workspaceId: string }>();
  const searchParams = useSearchParams();
  const { workspaceId } = params;
  const runIdFilter = searchParams.get("runId") ?? "";

  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runIdInput, setRunIdInput] = useState(runIdFilter);

  const load = useCallback(
    async (runId: string) => {
      setLoading(true);
      setError(null);
      try {
        const url = runId
          ? `/api/v1/workspaces/${workspaceId}/review-gates?runId=${encodeURIComponent(runId)}`
          : `/api/v1/workspaces/${workspaceId}/review-gates`;
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as { gates: ReviewGate[] };
        setGates(json.gates);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load review gates");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    load(runIdFilter);
  }, [load, runIdFilter]);

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    const url = new URL(window.location.href);
    if (runIdInput) {
      url.searchParams.set("runId", runIdInput);
    } else {
      url.searchParams.delete("runId");
    }
    window.history.pushState({}, "", url.toString());
    load(runIdInput);
  }

  return (
    <div className="mx-auto max-w-[1440px]">
      <h1 className="mb-4 text-sm font-semibold text-[var(--gray-12)]">
        Review Gates
      </h1>

      <form onSubmit={handleFilter} className="flex items-center gap-2 mb-4">
        <input
          type="text"
          value={runIdInput}
          onChange={(e) => setRunIdInput(e.target.value)}
          placeholder="Filter by run ID…"
          className="h-8 rounded border border-[var(--gray-05)] bg-[var(--gray-02)] px-3 text-sm font-mono text-[var(--gray-12)] placeholder-[var(--gray-08)] focus:outline-none focus:ring-2 focus:ring-[#ffe629] focus:ring-offset-2 focus:ring-offset-[var(--gray-00)]"
          style={{ minWidth: "260px" }}
        />
        <button
          type="submit"
          className="h-8 px-3 rounded border border-[var(--gray-06)] bg-[var(--gray-03)] text-sm text-[var(--gray-12)] hover:bg-[var(--gray-04)] transition-colors"
        >
          Filter
        </button>
        {runIdFilter && (
          <a
            href={`/dashboard/${workspaceId}/review-gates`}
            className="text-xs text-[var(--gray-09)] hover:text-[var(--gray-11)] transition-colors"
          >
            Clear
          </a>
        )}
      </form>

      {loading ? (
        <p className="text-sm text-[var(--gray-09)] animate-pulse py-8">
          Loading review gates…
        </p>
      ) : error ? (
        <p className="text-sm text-[#ff9592] py-8">{error}</p>
      ) : gates.length === 0 ? (
        <p className="text-sm text-[var(--gray-09)] py-8">
          {runIdFilter
            ? "No review gates found for this run."
            : "No review gates recorded yet."}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-3">
            {(() => {
              const passed = gates.filter((g) => g.status === "passed").length;
              const failed = gates.filter((g) => g.status === "failed").length;
              const pending = gates.filter((g) => g.status === "pending").length;
              return (
                <>
                  {passed > 0 && <span className="text-xs text-[#1fd8a4]">{passed} passed</span>}
                  {failed > 0 && <span className="text-xs text-[#ff9592]">{failed} failed</span>}
                  {pending > 0 && <span className="text-xs text-[#f5e147]">{pending} pending</span>}
                </>
              );
            })()}
          </div>
          <div className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)] overflow-hidden">
            {gates.map((gate) => (
              <GateRow key={gate.id} gate={gate} workspaceId={workspaceId} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
