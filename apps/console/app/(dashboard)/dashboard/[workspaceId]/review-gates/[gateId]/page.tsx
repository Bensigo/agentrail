"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

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

/**
 * Breadcrumb trail back to Review Gates (this entity's list page) and to
 * Work (#1232 AC2), mirroring the run-detail pattern (#1231): a Back
 * control that returns to the immediate list, plus a full crumb trail. The
 * leaf shows the gate name when it has loaded; names over IDs.
 */
function GateBreadcrumb({
  workspaceId,
  gateName,
}: {
  workspaceId: string;
  gateName?: string;
}) {
  return (
    <div className="mb-4 flex items-center gap-2 text-xs text-[var(--gray-09)]">
      <a
        href={`/dashboard/${workspaceId}/review-gates`}
        className="flex items-center gap-1 rounded px-1.5 py-1 text-[var(--gray-11)] transition-colors hover:bg-[var(--gray-03)] hover:text-[var(--gray-12)]"
        aria-label="Back to Review Gates"
      >
        <ArrowLeft size={14} />
        Back
      </a>
      <a
        href={`/dashboard/${workspaceId}/work`}
        className="hover:text-[var(--gray-11)] transition-colors"
      >
        Work
      </a>
      <span>/</span>
      <a
        href={`/dashboard/${workspaceId}/review-gates`}
        className="hover:text-[var(--gray-11)] transition-colors"
      >
        Review Gates
      </a>
      {gateName && (
        <>
          <span>/</span>
          <span className="max-w-[320px] truncate">{gateName}</span>
        </>
      )}
    </div>
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

  if (loading) {
    return (
      <div className="mx-auto max-w-[900px]">
        <GateBreadcrumb workspaceId={workspaceId} />
        <p className="text-sm text-[var(--gray-09)] animate-pulse py-8">
          Loading review gate...
        </p>
      </div>
    );
  }

  if (error || !gate) {
    return (
      <div className="mx-auto max-w-[900px]">
        <GateBreadcrumb workspaceId={workspaceId} />
        <p className="text-sm text-[#ff9592] py-8">{error ?? "Review gate not found"}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <GateBreadcrumb workspaceId={workspaceId} gateName={gate.gateName} />

      <div className="mb-6 flex flex-col gap-3 border-b border-[var(--gray-05)] pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-[var(--gray-12)]">
            {gate.gateName}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--gray-09)]">
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

      <section className="rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <div className="border-b border-[var(--gray-05)] px-4 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]">
            Gate Explainer
          </h2>
        </div>
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
    </div>
  );
}
