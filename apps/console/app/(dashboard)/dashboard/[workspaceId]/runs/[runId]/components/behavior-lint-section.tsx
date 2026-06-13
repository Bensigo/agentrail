"use client";

import { useEffect, useState } from "react";
import { SectionEmpty, SectionSkeleton } from "./section-states";

type LintSeverity = "warning" | "error";

interface LintFinding {
  rule: string;
  severity: LintSeverity;
  evidence_event_id: string;
}

interface BehaviorLintResponse {
  findings: LintFinding[];
}

interface BehaviorLintSectionProps {
  workspaceId: string;
  runId: string;
  runStatus?: string;
}

const RULE_LABELS: Record<string, string> = {
  excessive_file_reads: "Excessive file reads",
  full_file_read: "Full-file read",
  tool_loop: "Tool loop",
  context_blind_edit: "Context-blind edit",
  verification_skip: "Verification skip",
};

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule.replace(/_/g, " ");
}

function severityClass(severity: LintSeverity): string {
  if (severity === "error") {
    return "border-[#e5484d] bg-[#2a1516] text-[#ff9592]";
  }
  return "border-[#f76b15] bg-[#2a1b12] text-[#ffa057]";
}

export function BehaviorLintSection({
  workspaceId,
  runId,
  runStatus,
}: BehaviorLintSectionProps) {
  const [findings, setFindings] = useState<LintFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/workspaces/${workspaceId}/runs/${runId}/behavior-lint`
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body as { error?: string }).error ?? `HTTP ${res.status}`
          );
        }
        const json = (await res.json()) as BehaviorLintResponse;
        setFindings(json.findings);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to load behavior findings"
        );
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [workspaceId, runId]);

  if (loading) {
    return <SectionSkeleton lines={3} />;
  }

  if (error) {
    return <p className="py-4 text-sm text-[#ff9592]">{error}</p>;
  }

  if (findings.length === 0) {
    return (
      <SectionEmpty
        runStatus={runStatus}
        waitingText="Run in progress — behavior findings arrive with agent activity."
        emptyText="No behavior findings for this run."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
      <div className="hidden border-b border-[var(--gray-05)] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[var(--gray-09)] sm:grid sm:grid-cols-[1fr_96px_minmax(180px,240px)]">
        <span>Rule</span>
        <span>Severity</span>
        <span>Evidence</span>
      </div>
      <div className="divide-y divide-[var(--gray-04)]">
        {findings.map((finding, index) => {
          const anchorId = `event-${finding.evidence_event_id}`;
          return (
            <div
              key={`${finding.rule}-${finding.evidence_event_id}-${index}`}
              className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[1fr_96px_minmax(180px,240px)] sm:items-center"
            >
              <span className="font-medium text-[var(--gray-12)]">
                {ruleLabel(finding.rule)}
              </span>
              <span
                className={`inline-flex w-fit items-center rounded-sm border px-1.5 py-0.5 font-medium uppercase ${severityClass(
                  finding.severity
                )}`}
              >
                {finding.severity}
              </span>
              <a
                href={`#${encodeURIComponent(anchorId)}`}
                className="font-mono text-[#70b8ff] hover:underline"
              >
                {finding.evidence_event_id}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
