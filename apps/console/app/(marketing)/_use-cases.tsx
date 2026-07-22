import Image from "next/image";
import { DEMO_TASK_INPUT } from "./_conversation-demo-data";

/**
 * Landing v2's use-case stack (plan: docs/superpowers/plans/2026-07-22-landing-v2.md,
 * "What you can hand me") — four sticky cards that deck on top of each other
 * as the visitor scrolls. Pure CSS (`position: sticky` + staggered top
 * offsets): no scroll listeners, nothing to degrade — reduced-motion and
 * mobile get the same markup, which simply reads as stacked cards.
 *
 * Card 2's dashed chip is `DEMO_TASK_INPUT.title` — the SAME task the hero
 * phone prices, so the page tells one story, not two. No fabricated
 * transcripts, no invented numbers (the gate panel names the real gates:
 * second-model review + the repo's own tests — see
 * apps/console/lib/../verify gate wiring the how-we-work section describes).
 */

interface UseCase {
  title: string;
  line: string;
  visual: "overnight" | "chat" | "gates" | "budget";
}

const USE_CASES: UseCase[] = [
  {
    title: "Clear the backlog overnight",
    line: "Queue up issues before you log off. By morning each one is a pull request with a review trail.",
    visual: "overnight",
  },
  {
    title: "Text me a task",
    line: "A message becomes a brief, a budget, and a PR after you approve.",
    visual: "chat",
  },
  {
    title: "Fixes that prove themselves",
    line: "A second model reviews my work, and your own tests have to pass before anything counts as done.",
    visual: "gates",
  },
  {
    title: "Chores under a hard budget",
    line: "Dependency bumps, refactors, cleanups. I start on cheap models and escalate only when the task earns it.",
    visual: "budget",
  },
];

export function UseCases() {
  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-6">
      {USE_CASES.map((useCase, i) => (
        <div
          key={useCase.visual}
          className="sticky rounded-xl border border-[var(--gray-06)] bg-[var(--gray-00)] p-6 shadow-sm sm:p-10"
          style={{ top: 88 + i * 16 }}
        >
          <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
            <div className="max-w-[46ch]">
              <h3 className="text-heading-2">{useCase.title}</h3>
              <p className="mt-3 text-[var(--gray-11)]">{useCase.line}</p>
            </div>
            <CaseVisual visual={useCase.visual} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CaseVisual({ visual }: { visual: UseCase["visual"] }) {
  if (visual === "overnight") {
    return (
      <Image
        src="/jace-working.png"
        alt=""
        width={170}
        height={170}
        className="-rotate-2 shrink-0 mix-blend-multiply"
      />
    );
  }
  if (visual === "chat") {
    return (
      <div className="flex shrink-0 flex-col items-start gap-2.5">
        <span className="text-mono-data rounded-md border border-dashed border-[var(--gray-08)] px-2.5 py-1 font-mono text-[var(--gray-12)]">
          {DEMO_TASK_INPUT.title}
        </span>
        <span className="text-mono-data px-1 font-mono text-[var(--gray-11)]">
          brief → approve → PR
        </span>
      </div>
    );
  }
  if (visual === "gates") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono">
        <span className="text-[var(--green-11)]">✓ second-model review</span>
        <span className="text-[var(--green-11)]">✓ your tests</span>
        <span className="text-[var(--gray-11)]">• your merge: waits for you</span>
      </div>
    );
  }
  return (
    <span className="text-mono-data shrink-0 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
      cheap model first → escalate only if earned
    </span>
  );
}
