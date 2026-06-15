"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "../../../../../components/page-header";
import { SectionHeader } from "../../../../components/section-header";
import { LoadingState } from "../../../../components/loading-state";
import { ErrorState } from "../../../../components/error-state";

type ReviewGateStatus = "passed" | "failed" | "pending";
type Category = "tests" | "visual" | "citations" | "ac" | "blocked";

interface ReviewGate {
  id: string;
  runId: string;
  gateName: string;
  status: ReviewGateStatus;
  evaluatedAt: string | null;
}

interface CategoryStatus {
  category: Category;
  present: boolean;
  finding_count: number;
}

const CATEGORY_ORDER: Category[] = ["tests", "visual", "citations", "ac", "blocked"];

function StatusBadge({ status }: { status: ReviewGateStatus }) {
  const styles: Record<ReviewGateStatus, string> = {
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

function EvidenceBadge({ present }: { present: boolean }) {
  return (
    <span
      className={
        present
          ? "px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[#1a3d33] text-[#1fd8a4]"
          : "px-1.5 py-0.5 rounded-sm text-xs font-medium bg-[#3d1a1a] text-[#ff9592]"
      }
    >
      {present ? "present" : "missing"}
    </span>
  );
}

function formatEvaluatedAt(value: string | null) {
  if (!value) return "not evaluated";
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function ReviewGateDetailPage() {
  const params = useParams<{ workspaceId: string; gateId: string }>();
  const { workspaceId, gateId } = params;

  const [gate, setGate] = useState<ReviewGate | null>(null);
  const [explainer, setExplainer] = useState<CategoryStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [gateRes, explainerRes] = await Promise.all([
          fetch(`/api/v1/workspaces/${workspaceId}/review-gates/${gateId}`),
          fetch(`/api/v1/workspaces/${workspaceId}/review-gates/${gateId}/explainer`),
        ]);

        if (!gateRes.ok) {
          const body = await gateRes.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${gateRes.status}`);
        }
        if (!explainerRes.ok) {
          const body = await explainerRes.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${explainerRes.status}`);
        }

        const gateJson = (await gateRes.json()) as { gate: ReviewGate };
        const explainerJson = (await explainerRes.json()) as { explainer: CategoryStatus[] };
        setGate(gateJson.gate);
        setExplainer(explainerJson.explainer);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load review gate");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [workspaceId, gateId]);

  const rows = useMemo(() => {
    const byCategory = new Map(explainer.map((item) => [item.category, item]));
    return CATEGORY_ORDER.map(
      (category) =>
        byCategory.get(category) ?? {
          category,
          present: false,
          finding_count: 0,
        }
    );
  }, [explainer]);

  return (
    <div className="mx-auto max-w-[900px]">
      <a
        href={`/dashboard/${workspaceId}/review-gates`}
        className="mb-4 inline-flex text-xs text-[var(--gray-09)] hover:text-[var(--gray-12)] transition-colors"
      >
        ← gates
      </a>

      {loading ? (
        <LoadingState variant="list" rows={5} />
      ) : error || !gate ? (
        <ErrorState message={error ?? "Review gate not found"} />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <PageHeader title={gate.gateName} subtitle={gateId} />
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--gray-09)]">
                <a
                  href={`/dashboard/${workspaceId}/runs/${gate.runId}`}
                  className="font-mono text-[#70b8ff] hover:underline"
                >
                  run:{gate.runId}
                </a>
                <span className="font-mono">{formatEvaluatedAt(gate.evaluatedAt)}</span>
              </div>
            </div>
            <StatusBadge status={gate.status} />
          </div>

          <div className="mb-4 border-b border-[var(--gray-05)]" />

          <SectionHeader title="Gate Explainer" />
          <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
            <div className="divide-y divide-[var(--gray-04)]">
              {rows.map((row) => (
                <div
                  key={row.category}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5"
                >
                  <span className="font-mono text-sm text-[var(--gray-12)]">
                    {row.category}
                  </span>
                  <EvidenceBadge present={row.present} />
                  <span className="w-16 text-right font-mono text-xs text-[var(--gray-09)]">
                    {row.finding_count} finding{row.finding_count === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
