import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const PRICING_DIR = dirname(__filename);
const MARKETING_DIR = resolve(PRICING_DIR, "..");
const REPO_ROOT = resolve(MARKETING_DIR, "../../../..");

function stripComments(source: string): string {
  return source
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function sourceAt(...path: string[]): string {
  return stripComments(readFileSync(resolve(...path), "utf8"));
}

const LANDING_PUBLIC_FILES = [
  "page.tsx",
  "_use-cases.tsx",
  "_channels.tsx",
  "_channel-cards.ts",
  "_phone-demo.tsx",
  "_conversation-demo.tsx",
  "_conversation-demo-data.ts",
  "_cta.ts",
  "_nav.tsx",
  "pricing/tier-cards.tsx",
  "pricing/tiers.ts",
] as const;

const landingPublicSources = Object.fromEntries(
  LANDING_PUBLIC_FILES.map((file) => [file, sourceAt(MARKETING_DIR, file)]),
) as Record<(typeof LANDING_PUBLIC_FILES)[number], string>;
const landingSource = landingPublicSources["page.tsx"];
const useCasesSource = landingPublicSources["_use-cases.tsx"];
const publicLandingSource = Object.values(landingPublicSources).join("\n");
const pricingSource = [
  sourceAt(PRICING_DIR, "page.tsx"),
  sourceAt(PRICING_DIR, "tiers.ts"),
  sourceAt(PRICING_DIR, "tier-cards.tsx"),
].join("\n");
const architectureSource = readFileSync(
  resolve(REPO_ROOT, "docs/design/landing-content-architecture.md"),
  "utf8",
);
const normalizedPricingSource = pricingSource.replace(/\s+/g, " ");

describe("R12.1 landing truth boundary", () => {
  it("keeps the full canonical flow in order inside the rendered HOW_WE_WORK structure", () => {
    const start = landingSource.indexOf("const HOW_WE_WORK = [");
    const end = landingSource.indexOf("\n];", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const howWeWork = landingSource.slice(start, end);
    expect(howWeWork.match(/name:/g)).toHaveLength(4);
    expect(landingSource).toContain("HOW_WE_WORK.map((step, i) =>");
    expect(landingSource).toContain("{step.name}");
    expect(landingSource).toContain("{step.line}");

    const flowMarkers = [
      "Define the work",
      "planned checks",
      "You confirm it before work starts.",
      "Give the coding agent focused context",
      "external coding agent",
      "The coding agent writes the code.",
      "Verify and correct",
      "exact change",
      "agreed criteria",
      "correction path",
      "Human decides",
      "accepts, reworks, or rejects it.",
    ];

    let previousIndex = -1;
    for (const marker of flowMarkers) {
      const markerIndex = howWeWork.indexOf(marker);
      expect(
        markerIndex,
        `missing ordered flow marker: ${marker}`,
      ).toBeGreaterThan(previousIndex);
      previousIndex = markerIndex;
    }
  });

  it("scans the rendered landing source set for factory, codegen, auto-merge, or live-looking copy", () => {
    for (const [file, source] of Object.entries(landingPublicSources)) {
      for (const phrase of ["factory", "codegen", "auto-merge", "live cached stats"]) {
        expect(source.toLowerCase(), `${file} contains ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("describes Jace as the dependency-upgrade control layer, not the code executor", () => {
    const dependencyStart = landingSource.indexOf("Keep dependency upgrades moving safely");
    const dependencyEnd = landingSource.indexOf("</section>", dependencyStart);
    expect(dependencyStart).toBeGreaterThan(-1);
    expect(dependencyEnd).toBeGreaterThan(dependencyStart);
    const dependencyUseCase = landingSource.slice(dependencyStart, dependencyEnd);
    const dependencyFlow = [
      "dependencies your team selects",
      "available updates",
      "compatibility evidence",
      "prepares a proposal",
      "human approval",
      "selected external coding agent",
      "bounded dependency-upgrade Pack",
      "The coding agent makes the code change",
      "verifies the evidence or refuses success",
    ];

    let previousIndex = -1;
    for (const marker of dependencyFlow) {
      const markerIndex = dependencyUseCase.indexOf(marker);
      expect(markerIndex, `missing dependency-flow marker: ${marker}`).toBeGreaterThan(previousIndex);
      previousIndex = markerIndex;
    }

    expect(useCasesSource).not.toContain("dependency");
    expect(dependencyUseCase).not.toContain("Jace makes the code change");
    expect(dependencyUseCase).not.toContain("Jace executes the upgrade");
  });
});

describe("R12.2 pricing and technical-doc boundaries", () => {
  it("frames both public pricing surfaces as a team commercial experiment, not a product-value claim", () => {
    expect(landingSource).toContain("A team commercial experiment");
    expect(landingSource).toContain("not to promise a product outcome");
    expect(pricingSource).toContain("team-size terms for a commercial experiment");
    expect(normalizedPricingSource).toContain("do not claim product value, delivery outcomes");
  });

  it("keeps price and seat terms without implying a monthly delivery allocation", () => {
    expect(pricingSource).toContain("$199/mo");
    expect(pricingSource).toContain("$399/mo");
    expect(pricingSource).toContain("Terms under evaluation");
    expect(pricingSource).toContain("Commercial status");

    const publicCopy = `${publicLandingSource}\n${pricingSource}`;
    const forbiddenClaims = [
      /≈\d+\s+tasks?/i,
      /tasks?\s*\/\s*mo/i,
      /tasks? a month/i,
      /task allocation/i,
      /monthly allocation/i,
      /reviewable engineering work/i,
      /monthly engineering capacity/i,
      /ships as a pull request/i,
      /fewer review hours/i,
      /more generated code/i,
    ];
    for (const claim of forbiddenClaims) {
      expect(publicCopy).not.toMatch(claim);
    }
  });

  it("keeps optional-adapter terminology in technical docs, not public copy", () => {
    expect(`${publicLandingSource}\n${pricingSource}`).not.toMatch(/\badapters?\b/i);
  });

  it("preserves the explicit technical-doc boundary for optional internal adapters", () => {
    expect(architectureSource).toContain("Technical documentation may describe optional internal adapters");
    expect(architectureSource).toContain("not public promises that Jace will generate code");
  });
});
