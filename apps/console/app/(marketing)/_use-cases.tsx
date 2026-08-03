/**
 * Landing v2's use-case stack — sticky cards that deck on top of each other
 * as the visitor scrolls. Pure CSS (`position: sticky` + staggered top
 * offsets): no scroll listeners, nothing to degrade — reduced-motion and
 * mobile get the same markup, which simply reads as stacked cards.
 *
 * The deck is now outcome-led. It names the acceptance mechanics from the
 * market research without implying that the future dependency workflow is
 * already shipped. “Coming soon” is deliberately part of the card data.
 */

interface UseCase {
  title: string;
  line: string;
  visual: "dependency" | "contract" | "reviewable" | "regression" | "proof";
  comingSoon?: boolean;
}

const USE_CASES: UseCase[] = [
  {
    title: "Migrations and dependency upgrades",
    line: "Migrations are the beachhead. Dependency upgrade workflow stays Coming soon until the capability ships.",
    visual: "dependency",
    comingSoon: true,
  },
  {
    title: "Start with an acceptance contract",
    line: "Define the goal, non-goals, acceptance criteria, blast radius, and stop conditions before implementation begins.",
    visual: "contract",
  },
  {
    title: "Keep changes reviewable",
    line: "Work should arrive as a small, focused pull request your team can understand and accept without reconstructing the whole run.",
    visual: "reviewable",
  },
  {
    title: "Verify non-regression",
    line: "The change earns its way through tests and independent verification. A green diff is not enough on its own.",
    visual: "regression",
  },
  {
    title: "Show proof — or stop",
    line: "The pull request carries the evidence behind the result. If the acceptance contract cannot be proven, Jace refuses to present success.",
    visual: "proof",
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
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-heading-2">{useCase.title}</h3>
                {useCase.comingSoon ? (
                  <span className="text-label rounded-sm border border-[var(--gray-07)] px-2 py-1 text-[var(--gray-11)]">
                    Coming soon
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-[var(--gray-11)]">{useCase.line}</p>
            </div>
            <CaseVisual visual={useCase.visual} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** One visual grammar for every card (owner feedback 2026-07-22: no
 *  image-on-one-card-only inconsistency): each case gets a small mono ink
 *  panel showing the card's mechanic. The mascot renders live outside the
 *  stack — hero-adjacent phone, channels background, closing wave. */
function CaseVisual({ visual }: { visual: UseCase["visual"] }) {
  if (visual === "dependency") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono">
        <span>migration plan</span>
        <span className="text-[var(--gray-12)]">→ dependency upgrade workflow</span>
        <span className="text-[var(--gray-12)]">→ Coming soon</span>
      </div>
    );
  }
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
  return (
    <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
      <span>acceptance criteria</span>
      <span className="text-[var(--gray-12)]">→ evidence attached</span>
      <span className="text-[var(--gray-12)]">or → refused</span>
    </div>
  );
}
