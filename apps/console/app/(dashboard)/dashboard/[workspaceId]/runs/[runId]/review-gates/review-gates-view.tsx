"use client";

import { useEffect, useState } from "react";

interface ReviewGate {
  id: string;
  gateName: string;
  status: "passed" | "failed" | "pending";
  conditions: string[];
  blockingReasons: string[];
  evidenceRefs: string[];
  evaluatedAt: string | null;
}

const statusConfig: Record<string, { icon: string; color: string }> = {
  passed: { icon: "✓", color: "text-[#29a383]" },
  failed: { icon: "✕", color: "text-[#e5484d]" },
  pending: { icon: "⏳", color: "text-[#f5d90a]" },
};

export function ReviewGatesView({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [gates, setGates] = useState<ReviewGate[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/v1/workspaces/${workspaceId}/runs/${runId}/review-gates`)
      .then((r) => r.json())
      .then((data) => {
        setGates(data.gates ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId, runId]);

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-[var(--gray-03)]" />
        ))}
      </div>
    );
  }

  if (gates.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--gray-09)]">
        No review gates configured for this run.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {gates.map((gate) => {
        const cfg = statusConfig[gate.status] ?? statusConfig.pending;
        const isExpanded = expanded.has(gate.id);
        return (
          <div
            key={gate.id}
            className="rounded border border-[var(--gray-05)] bg-[var(--gray-01)]"
          >
            <button
              onClick={() => {
                const next = new Set(expanded);
                if (isExpanded) next.delete(gate.id);
                else next.add(gate.id);
                setExpanded(next);
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span className={`text-lg font-bold ${cfg.color}`}>{cfg.icon}</span>
              <span className="text-sm font-medium text-[var(--gray-12)]">
                {gate.gateName}
              </span>
              <span className={`ml-auto rounded-sm px-1.5 py-0.5 text-xs font-medium ${cfg.color}`}>
                {gate.status}
              </span>
            </button>
            {isExpanded && (
              <div className="border-t border-[var(--gray-04)] px-4 py-3 space-y-3">
                {gate.conditions.length > 0 && (
                  <div>
                    <p className="text-xs uppercase text-[var(--gray-09)]">Conditions</p>
                    <ul className="mt-1 space-y-1">
                      {gate.conditions.map((c, i) => (
                        <li key={i} className="text-sm text-[var(--gray-11)]">
                          {c}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {gate.blockingReasons.length > 0 && (
                  <div>
                    <p className="text-xs uppercase text-[var(--red-09,var(--gray-09))]">
                      Blocking Reasons
                    </p>
                    <ul className="mt-1 space-y-1">
                      {gate.blockingReasons.map((r, i) => (
                        <li key={i} className="text-sm text-[#e5484d]">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {gate.evidenceRefs.length > 0 && (
                  <div>
                    <p className="text-xs uppercase text-[var(--gray-09)]">Evidence</p>
                    <ul className="mt-1 space-y-1">
                      {gate.evidenceRefs.map((ref, i) => (
                        <li key={i} className="font-mono text-xs text-[var(--blue-09)] underline">
                          {ref}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {gate.evaluatedAt && (
                  <p className="font-mono text-xs text-[var(--gray-09)]">
                    Evaluated: {new Date(gate.evaluatedAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
