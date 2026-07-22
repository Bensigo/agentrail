import Image from "next/image";
import { DEMO_TASK_INPUT } from "./_conversation-demo-data";

/**
 * Landing v2's use-case stack ("Use cases", heading + content per owner
 * feedback 2026-07-22) — sticky cards that deck on top of each other as the
 * visitor scrolls. Pure CSS (`position: sticky` + staggered top offsets):
 * no scroll listeners, nothing to degrade — reduced-motion and mobile get
 * the same markup, which simply reads as stacked cards.
 *
 * Every card maps to a REAL product surface, not marketing invention:
 * 1. overnight  — the work queue drains GitHub/Linear issues into PRs
 *    (dashboard → Work / Runs).
 * 2. chat       — chat-born tasks: message → alignment brief → approval →
 *    PR (the same DEMO_TASK_INPUT the hero phone prices).
 * 3. ideas      — Jace's ideation door: a rough goal becomes scoped,
 *    house-format GitHub issues (the coordinator's issue contract).
 * 4. gates      — the verify gate: second-model review + the repo's own
 *    tests; failures land in the console's Failures view, counted.
 * 5. budget     — budget caps + cheap-first model selection; every run's
 *    cost sits beside its PR (dashboard → Costs).
 */

interface UseCase {
  title: string;
  line: string;
  visual: "overnight" | "chat" | "ideas" | "gates" | "budget";
}

const USE_CASES: UseCase[] = [
  {
    title: "Clear the backlog overnight",
    line: "Queue up GitHub or Linear issues before you log off. By morning each one is a pull request with a review trail.",
    visual: "overnight",
  },
  {
    title: "Text me a task",
    line: "A message becomes a brief, a budget, and a PR after you approve.",
    visual: "chat",
  },
  {
    title: "Turn an idea into scoped work",
    line: "Describe what you want in chat. I ask the hard questions, then file scoped issues your whole team can read.",
    visual: "ideas",
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
            <div className="max-w-[44ch]">
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
        width={220}
        height={220}
        className="-rotate-2 shrink-0"
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
  if (visual === "ideas") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>you: “billing needs retries”</span>
        <span className="text-[var(--gray-12)]">→ issue #1 webhook backoff</span>
        <span className="text-[var(--gray-12)]">→ issue #2 failure ledger</span>
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
