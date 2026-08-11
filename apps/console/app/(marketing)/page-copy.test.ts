import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const MARKETING_DIR = dirname(__filename);
const landingSource = readFileSync(resolve(MARKETING_DIR, "page.tsx"), "utf8");
const useCasesSource = readFileSync(resolve(MARKETING_DIR, "_use-cases.tsx"), "utf8");

describe("landing story", () => {
  it("leads with team outcomes and keeps the dependency use case out of that stack", () => {
    expect(landingSource).toContain("What your team gets from Jace");
    expect(landingSource).toContain(
      "Clearer work, focused changes, and the evidence to make the call.",
    );

    for (const outcome of [
      "Start with a clear definition of done",
      "Review a focused change",
      "See what was checked",
      "Decide from proof, not a green diff",
    ]) {
      expect(useCasesSource).toContain(outcome);
    }

    expect(useCasesSource).not.toContain("dependency");
    expect(landingSource).toContain("ONE USE CASE");
    expect(landingSource).toContain(
      "Review dependency upgrades with the evidence attached",
    );
  });

  it("makes the team, coding agent, and Jace roles explicit in order", () => {
    expect(landingSource).toContain(
      "How Jace works with your team and coding agents",
    );
    expect(landingSource).toContain("Your coding agent writes the code.");
    expect(landingSource).toContain(
      "Jace keeps the agreement, context, evidence, and corrections connected around it.",
    );

    const start = landingSource.indexOf("const HOW_WE_WORK = [");
    const end = landingSource.indexOf("\n];", start);
    const workflow = landingSource.slice(start, end);
    const steps = [
      "Define the work",
      "Give the coding agent focused context",
      "Verify and correct",
      "Human decides",
    ];

    let previousIndex = -1;
    for (const step of steps) {
      const stepIndex = workflow.indexOf(step);
      expect(stepIndex, `missing workflow step: ${step}`).toBeGreaterThan(previousIndex);
      previousIndex = stepIndex;
    }
  });
});
