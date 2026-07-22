/**
 * Landing v2's use-case stack — sticky cards that deck on top of each other
 * as the visitor scrolls. Pure CSS (`position: sticky` + staggered top
 * offsets): no scroll listeners, nothing to degrade — reduced-motion and
 * mobile get the same markup, which simply reads as stacked cards.
 *
 * Owner ruling 2026-07-23: the deck is the TOP FIVE differentiators, not a
 * task-type catalog. Commodity work (issue lists, small features, tests,
 * chores) is already told by the phone act + "How I work"; each card here
 * must carry a mechanic competitors don't claim, and every card maps to a
 * REAL product surface:
 * 1. stacktrace — the verify gate's red-green rule: the failure is
 *    reproduced as a failing test before the fix counts.
 * 2. ideas      — Jace's ideation door (grill-me / to-issues skills): a
 *    rough goal becomes scoped, house-format GitHub issues.
 * 3. goal       — the goal loop (create_goal + console leash meter):
 *    goal + repo in, scoped issues worked under a leash the owner sets.
 * 4. qa         — the codebase-qa skill: answers cite the file + line range
 *    the context CLI returned, or say "not found" — never model memory.
 * 5. research   — the researcher subagent: every external-tech claim ships
 *    as claim → source URL → version; unverified claims are dropped.
 */

interface UseCase {
  title: string;
  line: string;
  visual: "stacktrace" | "ideas" | "goal" | "qa" | "research";
}

const USE_CASES: UseCase[] = [
  {
    title: "Paste the stack trace",
    line: "Hand me a bug report. I reproduce it with a failing test, then fix until it passes.",
    visual: "stacktrace",
  },
  {
    title: "Turn an idea into scoped work",
    line: "Describe what you want in chat. I ask the hard questions, then file scoped issues your whole team can read.",
    visual: "ideas",
  },
  {
    title: "Hand me a goal",
    line: "Give me a goal and a repo. I break it into scoped issues and work through them, on a leash you set.",
    visual: "goal",
  },
  {
    title: "Ask about your codebase",
    line: "Answers come from the code and cite the file and line. If I can't find it, I say so.",
    visual: "qa",
  },
  {
    title: "Send me a research question",
    line: "Which library, which version, what changed. I come back with the source and version for every claim.",
    visual: "research",
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
  if (visual === "stacktrace") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono">
        <span className="text-[var(--red-11)]">✗ repro test · red</span>
        <span className="text-[var(--gray-11)]">fix: clamp retry spend</span>
        <span className="text-[var(--green-11)]">✓ same test · green</span>
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
  if (visual === "goal") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>goal: retire the legacy queue</span>
        <span className="text-[var(--gray-12)]">→ scoped into 6 issues</span>
        <span className="text-[var(--gray-12)]">leash: set by you</span>
      </div>
    );
  }
  if (visual === "qa") {
    return (
      <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
        <span>you: “where do retries get budgeted?”</span>
        <span className="text-[var(--gray-12)]">→ run/pricing.py:41–63</span>
        <span className="text-[var(--gray-12)]">cited, or “not found”</span>
      </div>
    );
  }
  return (
    <div className="text-mono-data flex shrink-0 flex-col gap-1.5 rounded-md border border-[var(--gray-05)] bg-[var(--gray-01)] px-4 py-3 font-mono text-[var(--gray-11)]">
      <span>claim → source → version</span>
      <span className="text-[var(--gray-12)]">no source, no claim</span>
    </div>
  );
}
