"use client";

import { useEffect, useState } from "react";

interface Failure {
  event_id: string;
  run_id: string;
  repository_id: string;
  failure_type: string;
  message: string;
  evidence: string;
  phase: string;
  severity: string;
  occurred_at: string;
}

const severityColors: Record<string, string> = {
  critical: "bg-[#e5484d]/20 text-[#e5484d]",
  high: "bg-[#f76b15]/20 text-[#f76b15]",
  medium: "bg-[#f5d90a]/20 text-[#f5d90a]",
  low: "bg-[var(--gray-04)] text-[var(--gray-11)]",
};

const severityOptions = ["all", "critical", "high", "medium", "low"] as const;

export function FailuresList({ workspaceId }: { workspaceId: string }) {
  const [failures, setFailures] = useState<Failure[]>([]);
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const params = new URLSearchParams();
    if (severity !== "all") params.set("severity", severity);

    fetch(`/api/v1/workspaces/${workspaceId}/failures?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setFailures(data.failures ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId, severity]);

  return (
    <div className="mt-4">
      <div className="flex gap-1">
        {severityOptions.map((opt) => (
          <button
            key={opt}
            onClick={() => setSeverity(opt)}
            className={`rounded-sm px-2 py-1 text-xs font-medium capitalize ${
              severity === opt
                ? "bg-[var(--brand-accent)] text-[var(--gray-00)]"
                : "text-[var(--gray-09)] hover:text-[var(--gray-11)]"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-[var(--gray-03)]" />
          ))}
        </div>
      ) : failures.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--gray-09)]">No failures found.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--gray-04)] text-left text-xs uppercase text-[var(--gray-09)]">
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Phase</th>
                <th className="px-3 py-2">Run</th>
                <th className="px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => {
                const isExpanded = expanded.has(f.event_id);
                return (
                  <>
                    <tr
                      key={f.event_id}
                      onClick={() => {
                        const next = new Set(expanded);
                        if (isExpanded) next.delete(f.event_id);
                        else next.add(f.event_id);
                        setExpanded(next);
                      }}
                      className="cursor-pointer border-b border-[var(--gray-03)] hover:bg-[var(--gray-02)]"
                    >
                      <td className="px-3 py-2">
                        <span className={`rounded-sm px-1.5 py-0.5 text-xs font-medium ${severityColors[f.severity] ?? ""}`}>
                          {f.severity}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--gray-12)]">
                        {f.failure_type}
                      </td>
                      <td className="max-w-[400px] truncate px-3 py-2 text-xs text-[var(--gray-11)]">
                        {f.message}
                      </td>
                      <td className="px-3 py-2 text-xs text-[var(--gray-09)]">
                        {f.phase}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                        {f.run_id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--gray-09)]">
                        {new Date(f.occurred_at).toLocaleString()}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${f.event_id}-detail`}>
                        <td colSpan={6} className="bg-[var(--gray-01)] px-3 py-4">
                          <div className="space-y-3">
                            <div>
                              <p className="text-xs uppercase text-[var(--gray-09)]">Message</p>
                              <p className="mt-1 text-sm text-[var(--gray-12)]">{f.message}</p>
                            </div>
                            <div>
                              <p className="text-xs uppercase text-[var(--gray-09)]">Evidence</p>
                              <pre className="mt-1 overflow-x-auto rounded border border-[var(--gray-04)] bg-[var(--gray-02)] p-3 font-mono text-xs text-[var(--gray-11)]">
                                {(() => {
                                  try {
                                    return JSON.stringify(JSON.parse(f.evidence), null, 2);
                                  } catch {
                                    return f.evidence;
                                  }
                                })()}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
