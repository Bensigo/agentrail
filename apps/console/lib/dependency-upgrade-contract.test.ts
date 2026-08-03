import { describe, expect, it } from "vitest";
import {
  buildDependencyUpgradeApprovalInput,
  buildDependencyUpgradeIssueBody,
  buildDependencyUpgradeProposal,
} from "./dependency-upgrade-contract";

const candidate = {
  package: "react",
  ecosystem: "node",
  package_manager: "npm",
  dependency_kind: "dependencies",
  specifier: "^18.2.0",
  current_version: "18.2.0",
  target_version: "18.3.1",
  manifest_path: "package.json",
  lockfile_path: "pnpm-lock.yaml",
  baseline_sha: "abc123",
  fingerprint: "sha256:candidate-1",
  verification_commands: ["npm ci", "npm test"],
};

describe("dependency upgrade contract proposal", () => {
  it("contains the complete bounded outcome contract and house-format ACs", () => {
    const proposal = buildDependencyUpgradeProposal(candidate, {}, { observationKey: "candidates:one" });
    const body = buildDependencyUpgradeIssueBody(proposal);

    expect(proposal.releaseEvidence.length).toBeGreaterThan(0);
    expect(proposal.usageScope.length).toBeGreaterThan(0);
    expect(proposal.nonGoals.length).toBeGreaterThan(0);
    expect(proposal.expectedFiles).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(proposal.stopConditions.length).toBeGreaterThan(0);
    expect(proposal.requiredProof.length).toBeGreaterThan(0);
    expect(proposal.verificationCommands).toEqual([
      "npm ci",
      "npm test",
    ]);
    expect(proposal.acceptanceCriteria).toHaveLength(7);
    expect(body).toContain("Candidate fingerprint: sha256:candidate-1");
    expect(body).toContain("Observation key: candidates:one");
    expect(body.match(/^- \[ \] AC\d+:/gm)).toHaveLength(7);
    expect(body).toContain("Release evidence");
    expect(body).toContain("Package manager: npm");
    expect(body).toContain("Usage scope");
    expect(body).toContain("Transitive and peer compatibility");
    expect(body).toContain("Security evidence");
    expect(body).toContain("Baseline tests and target tests");
    expect(body).toContain("independent-verification");
  });

  it("uses the existing alignment brief fields for the approval payload", () => {
    const proposal = buildDependencyUpgradeProposal(candidate, {}, { observationKey: "candidates:one" });
    const input = buildDependencyUpgradeApprovalInput("contract-1", proposal);

    expect(input).toMatchObject({
      contractId: "contract-1",
      title: proposal.title,
      candidateFingerprint: candidate.fingerprint,
      observationKey: "candidates:one",
      proposal: expect.objectContaining({
        candidateFingerprint: candidate.fingerprint,
        observationKey: "candidates:one",
      }),
      suggestedModel: expect.objectContaining({ slug: expect.any(String) }),
      estimateUsd: expect.any(Number),
      acceptanceCriteria: proposal.acceptanceCriteria,
    });
  });

  it("does not let control characters create extra issue lines", () => {
    const proposal = buildDependencyUpgradeProposal({
      ...candidate,
      package: "react\n## pretend section\u202e",
    }, {}, { observationKey: "candidates:one" });
    const body = buildDependencyUpgradeIssueBody(proposal);
    expect(body).not.toContain("\n## pretend section");
    expect(body).not.toContain("\u202e");
  });

  it("preserves evidence issues rather than silently dropping malformed evidence", () => {
    const proposal = buildDependencyUpgradeProposal(
      candidate,
      {
        releaseEvidence: ["https://github.com/facebook/react/releases/tag/v18.3.1"],
        usageScope: ["Direct imports are limited to the web package."],
        transitiveCompatibility: "No peer conflicts.",
        security: "No known advisories.",
        baselineTests: ["npm ci"],
        targetTests: ["npm test"],
      },
      {
        observationKey: "candidates:one",
        evidenceIssues: ["releaseEvidence contains unsupported evidence"],
      }
    );

    expect(proposal.needsHumanDecision).toEqual(expect.arrayContaining([
      "releaseEvidence contains unsupported evidence",
    ]));
    expect(proposal.evidenceIssues).toEqual(["releaseEvidence contains unsupported evidence"]);
  });
});
