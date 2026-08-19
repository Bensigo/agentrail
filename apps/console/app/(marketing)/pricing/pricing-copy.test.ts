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
const rootLayoutSource = sourceAt(MARKETING_DIR, "..", "layout.tsx");
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
      "Plan and confirm the Acceptance Contract",
      "planned scope and criteria",
      "A human on your team confirms the Acceptance Contract",
      "Hand off through MCP",
      "MCP",
      "confirmed Acceptance Contract and a bounded Context Pack",
      "selected external coding agent",
      "The coding agent writes the code.",
      "Review the exact head",
      "exact PR head",
      "confirmed intent",
      "criterion evidence",
      "refuses success",
      "provides a correction path",
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
    const truthBoundarySources = {
      ...landingPublicSources,
      "../layout.tsx": rootLayoutSource,
    };
    for (const [file, source] of Object.entries(truthBoundarySources)) {
      const normalized = source.replace(/\s+/g, " ");
      for (const claim of [
        /\bfactory\b/i,
        /\bcodegen\b/i,
        /\bJace (?:is|acts as) (?:a )?code generator\b/i,
        /(?<!not claim that )\bJace (?:generates?|will generate) code\b/i,
        /\bauto-merge\b/i,
        /\bJace automatically merges?\b/i,
        /\blive cached stats\b/i,
        /\bJace turns approved engineering work into reviewable pull requests?\b/i,
        /(?<!not claim that )\bJace (?:delivers?|will deliver) (?:a |the )?pull requests?\b/i,
      ]) {
        expect(normalized, `${file} contains ${claim}`).not.toMatch(claim);
      }
    }
  });

  it("labels the chat as illustrative and keeps root metadata on the trust-layer role split", () => {
    const demoStart = landingSource.indexOf("<PhoneDemo />");
    const demoEnd = landingSource.indexOf("</section>", demoStart);
    expect(demoStart).toBeGreaterThan(-1);
    expect(demoEnd).toBeGreaterThan(demoStart);
    expect(landingSource.slice(demoStart, demoEnd)).toContain("Illustrative example");
    expect(rootLayoutSource).toContain("evidence and control for AI coding agents");
    expect(rootLayoutSource).toContain("human-confirmed Acceptance Contracts");
    expect(rootLayoutSource).toContain("external coding agents");
  });

  it("describes Jace as the dependency-upgrade control layer, not the code executor", () => {
    const dependencyStart = useCasesSource.indexOf("Keep dependency upgrades moving safely");
    const dependencyEnd = useCasesSource.indexOf("\n  },", dependencyStart);
    expect(dependencyStart).toBeGreaterThan(-1);
    expect(dependencyEnd).toBeGreaterThan(dependencyStart);
    const dependencyUseCase = useCasesSource.slice(dependencyStart, dependencyEnd);
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

    expect(useCasesSource).not.toContain("Jace makes the code change");
    expect(useCasesSource).not.toContain("Jace executes the upgrade");
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
