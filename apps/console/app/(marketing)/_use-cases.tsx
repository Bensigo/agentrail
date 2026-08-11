/**
 * Landing v2's use-case stack — sticky cards that deck on top of each other
 * as the visitor scrolls. Pure CSS (`position: sticky` + staggered top
 * offsets): no scroll listeners, nothing to degrade — reduced-motion and
 * mobile get the same markup, which simply reads as stacked cards.
 *
 * The deck names concrete ways a team uses Jace. The dependency card is the
 * full, bounded workflow; Jace coordinates and verifies it, while the
 * selected external coding agent changes the code.
 */

interface UseCase {
  title: string;
  lines: string[];
  visual: "contract" | "reviewable" | "regression" | "proof" | "dependency";
}

const USE_CASES: UseCase[] = [
  {
    title: "Start with a clear definition of done",
    lines: [
      "Jace turns the request into an acceptance contract: the goal, non-goals, criteria, boundaries, and stop conditions your team confirms before work starts.",
    ],
    visual: "contract",
  },
  {
    title: "Review a focused change",
    lines: [
      "Work should arrive as a small, focused pull request your team can understand and accept without reconstructing the whole run.",
    ],
    visual: "reviewable",
  },
  {
    title: "See what was checked",
    lines: [
      "Jace connects tests and independent verification to the agreed criteria. A green diff is not enough on its own.",
    ],
    visual: "regression",
  },
  {
    title: "Decide from proof, not a green diff",
    lines: [
      "The pull request carries the evidence behind each result. If a criterion cannot be proven, Jace sends a correction path instead of presenting success.",
    ],
    visual: "proof",
  },
  {
    title: "Keep dependency upgrades moving safely",
    lines: [
      "Jace watches the dependencies your team selects, evaluates available updates and compatibility evidence, and prepares a proposal for human approval.",
      "After approval, Jace gives the selected external coding agent a bounded dependency-upgrade Pack. The coding agent makes the code change; Jace verifies the evidence or refuses success.",
    ],
    visual: "dependency",
  },
];

export function UseCases() {
  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6">
      {USE_CASES.map((useCase, i) => (
        <div
          key={useCase.visual}
          className="sticky rounded-xl border-2 border-[var(--gray-13)] bg-[var(--paper)] p-6 shadow-[5px_5px_0_0_var(--gray-13)] sm:p-10"
          style={{ top: 88 + i * 16 }}
        >
          <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
            <div className="max-w-[44ch]">
              <h3 className="text-heading-2">{useCase.title}</h3>
              {useCase.lines.map((line) => (
                <p key={line} className="mt-3 text-[var(--gray-11)]">
                  {line}
                </p>
              ))}
            </div>
            <CaseVisual visual={useCase.visual} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One visual grammar for every card: each case gets a small mono ink panel
 * showing the card's mechanic. The mascot renders live outside the stack. */
function CaseVisual({ visual }: { visual: UseCase["visual"] }) {
  if (visual === "contract") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>goal · payment retries</span>
        <span className="text-[var(--gray-12)]">non-goals · no API change</span>
        <span className="text-[var(--gray-12)]">stop · evidence missing</span>
      </div>
    );
  }
  if (visual === "reviewable") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>pull request · focused</span>
        <span className="text-[var(--gray-12)]">blast radius · named</span>
        <span className="text-[var(--gray-12)]">review · bounded</span>
      </div>
    );
  }
  if (visual === "regression") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>tests · green</span>
        <span className="text-[var(--gray-12)]">independent check · passed</span>
        <span className="text-[var(--gray-12)]">regression · not found</span>
      </div>
    );
  }
  if (visual === "proof") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>acceptance criteria</span>
        <span className="text-[var(--gray-12)]">→ evidence attached</span>
        <span className="text-[var(--gray-12)]">or → refused</span>
      </div>
    );
  }
  return (
    <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
      <span>selected dependencies · checked</span>
      <span className="text-[var(--gray-12)]">proposal · human approval</span>
      <span className="text-[var(--gray-12)]">Pack → coding agent</span>
      <span className="text-[var(--gray-12)]">evidence → verify or refuse</span>
    </div>
  );
}
