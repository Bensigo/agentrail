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

// Each rule: a plain label, what it detects, and why it matters — so a finding
// is self-explanatory without reading the linter source.
const RULE_INFO: Record<string, { label: string; detects: string; why: string }> = {
  excessive_file_reads: {
    label: "Excessive file reads",
    detects: "The agent opened far more files than the task needed.",
    why: "Burns tokens and signals it was searching blindly instead of using compiled context.",
  },
  full_file_read: {
    label: "Full-file read",
    detects: "The agent read an entire file instead of the relevant line range.",
    why: "Whole-file reads are the main avoidable token cost — context packs return just the needed lines.",
  },
  tool_loop: {
    label: "Tool loop",
    detects: "The agent repeated the same tool call without making progress.",
    why: "Wastes tokens and time, and usually means it was stuck.",
  },
  context_blind_edit: {
    label: "Context-blind edit",
    detects: "The agent edited a file it never retrieved context for.",
    why: "High risk of incorrect changes — the edit wasn't grounded in the code it touched.",
  },
  verification_skip: {
    label: "Verification skip",
    detects: "The agent finished without running tests or a verification step.",
    why: "Unverified work is the top cause of failed review gates.",
  },
};

function ruleInfo(rule: string) {
  return RULE_INFO[rule] ?? { label: rule.replace(/_/g, " "), detects: "", why: "" };
}

// error = likely-wrong-output risk; warning = wasteful/sloppy but not unsafe.
function severityClass(severity: LintSeverity): string {
  if (severity === "error") {
    return "border-[var(--red-11)] bg-[color-mix(in_srgb,var(--red-11)_14%,transparent)] text-[var(--red-11)]";
  }
  return "border-[var(--orange-11)] bg-[color-mix(in_srgb,var(--orange-11)_14%,transparent)] text-[var(--orange-11)]";
}

function severityMeaning(severity: LintSeverity): string {
  return severity === "error"
    ? "Error — likely affected the output's correctness; worth reviewing."
    : "Warning — wasteful or sloppy, but not a correctness risk.";
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
    return <p className="py-4 text-sm text-[var(--red-11)]">{error}</p>;
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
    <div className="space-y-2">
      <p className="max-w-[80ch] text-xs leading-relaxed text-[var(--gray-09)]">
        Behavior findings flag wasteful or risky things the agent did during this
        run — reading whole files, looping on a tool, editing code it never read,
        skipping verification. They explain cost spikes and failed gates.
      </p>
      <div className="overflow-hidden rounded border border-[var(--gray-05)] bg-[var(--gray-02)]">
        <div className="divide-y divide-[var(--gray-04)]">
          {findings.map((finding, index) => {
            const anchorId = `event-${finding.evidence_event_id}`;
            const info = ruleInfo(finding.rule);
            return (
              <div
                key={`${finding.rule}-${finding.evidence_event_id}-${index}`}
                className="flex flex-col gap-1.5 px-3 py-2.5 text-xs sm:flex-row sm:items-start sm:gap-3"
              >
                <span
                  title={severityMeaning(finding.severity)}
                  className={`inline-flex w-fit shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-medium uppercase ${severityClass(
                    finding.severity
                  )}`}
                >
                  {finding.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-[var(--gray-12)]">{info.label}</span>
                  {info.detects && (
                    <p className="mt-0.5 text-[var(--gray-10)]">{info.detects}</p>
                  )}
                  {info.why && (
                    <p className="mt-0.5 text-[var(--gray-09)]">{info.why}</p>
                  )}
                </div>
                <a
                  href={`#${encodeURIComponent(anchorId)}`}
                  title={`Timeline event ${finding.evidence_event_id}`}
                  className="shrink-0 text-[var(--blue-11)] hover:underline"
                >
                  View in timeline →
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
