"use client";

import { useState } from "react";
import { ChevronDown, Check, SkipForward } from "lucide-react";
import type { OnboardingStepStatus } from "../../../../lib/onboarding-steps";

/** Compact status badge — mirrors ConnectorStatusBadge's tone (TASTE.md: badges). */
function StatusBadge({ status }: { status: OnboardingStepStatus }) {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--green-09)]/15 px-1.5 py-0.5 text-xs font-medium text-[var(--green-11)]">
        <Check size={11} /> Done
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--gray-04)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-10)]">
        <SkipForward size={11} /> Skipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-[var(--gray-04)] px-1.5 py-0.5 text-xs font-medium text-[var(--gray-10)]">
      To do
    </span>
  );
}

export function StepCard({
  index,
  title,
  status,
  defaultOpen,
  children,
}: {
  index: number;
  title: string;
  status: OnboardingStepStatus;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="flex flex-col rounded border border-[var(--gray-05)] bg-[var(--gray-01)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 p-3.5 text-left"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--gray-05)] bg-[var(--gray-02)] font-mono text-xs text-[var(--gray-10)]">
          {index}
        </span>
        {/* font-bold: this titles the step (heading role), matching the
            text-sm + gray-12 recipe used for real headings elsewhere. */}
        <span className="flex-1 text-sm font-bold text-[var(--gray-12)]">
          {title}
        </span>
        <StatusBadge status={status} />
        <ChevronDown
          size={15}
          className={`shrink-0 text-[var(--gray-09)] transition-transform duration-150 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--gray-04)] p-3.5">
          {children}
        </div>
      )}
    </div>
  );
}
