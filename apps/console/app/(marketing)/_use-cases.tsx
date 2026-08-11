/**
 * The landing's use-case bento. Each box names a concrete way Jace gives an
 * engineering team more control over agent work; the dependency box is a
 * complete, bounded workflow rather than a separate product category.
 */

interface UseCase {
  title: string;
  lines: string[];
}

const USE_CASES: UseCase[] = [
  {
    title: "Start with a clear definition of done",
    lines: [
      "Jace turns the request into an acceptance contract: the goal, non-goals, criteria, boundaries, and stop conditions your team confirms before work starts.",
    ],
  },
  {
    title: "Review a focused change",
    lines: [
      "Work should arrive as a small, focused pull request your team can understand and accept without reconstructing the whole run.",
    ],
  },
  {
    title: "See what was checked",
    lines: [
      "Jace connects tests and independent verification to the agreed criteria. A green diff is not enough on its own.",
    ],
  },
  {
    title: "Decide from proof, not a green diff",
    lines: [
      "The pull request carries the evidence behind each result. If a criterion cannot be proven, Jace sends a correction path instead of presenting success.",
    ],
  },
  {
    title: "Keep dependency upgrades moving safely",
    lines: [
      "Jace watches the dependencies your team selects, evaluates available updates and compatibility evidence, and prepares a proposal for human approval.",
      "After approval, Jace gives the selected external coding agent a bounded dependency-upgrade Pack. The coding agent makes the code change; Jace verifies the evidence or refuses success.",
    ],
  },
];

export function UseCases() {
  return (
    <ol className="mx-auto grid max-w-[1120px] grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-6">
      {USE_CASES.map((useCase, i) => (
        <li key={useCase.title} className={i < 3 ? "lg:col-span-2" : "lg:col-span-3"}>
          <div className="flex h-full flex-col rounded-xl border-2 border-[var(--gray-13)] bg-[var(--paper)] p-6 shadow-[5px_5px_0_0_var(--gray-13)] sm:p-8">
            <h3 className="text-heading-2">{useCase.title}</h3>
            {useCase.lines.map((line) => (
              <p key={line} className="mt-3 leading-relaxed text-[var(--gray-11)]">
                {line}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}
