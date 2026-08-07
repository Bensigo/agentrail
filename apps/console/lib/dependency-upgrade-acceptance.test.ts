import { describe, expect, it } from "vitest";
import { parseAcceptanceContract } from "@agentrail/contracts";
import type { DependencyUpgradeProposal } from "./dependency-upgrade-contract";
import { dependencyProposalToAcceptanceContract } from "./dependency-upgrade-acceptance";

const candidate = {
  package: "react", dependency_kind: "dependencies", specifier: "^18.0.0",
  current_version: "18.2.0", target_version: "18.3.0", manifest_path: "package.json",
  lockfile_path: "pnpm-lock.yaml", baseline_sha: "a".repeat(40), fingerprint: "sha256:candidate",
  verification_commands: ["pnpm test"],
};

function proposal(needsHumanDecision: string[]): DependencyUpgradeProposal {
  return {
    title: "Upgrade react from 18.2.0 to 18.3.0",
    whatToBuild: "Prepare the update.",
    acceptanceCriteria: ["Tests pass on the target lockfile."],
    releaseEvidence: [], usageScope: [], transitiveCompatibility: "", securityEvidence: "",
    baselineTests: [], targetTests: [], nonGoals: ["No unrelated refactor."],
    expectedFiles: ["package.json", "pnpm-lock.yaml"], stopConditions: ["Evidence is incomplete."],
    requiredProof: [], verificationCommands: ["pnpm test"], candidateFingerprint: candidate.fingerprint,
    candidate, needsHumanDecision,
  };
}

describe("dependency proposal Acceptance Contract bridge", () => {
  it("makes the candidate a draft contract with missing evidence as unresolved questions", () => {
    const contract = dependencyProposalToAcceptanceContract(proposal(["canonical release evidence is missing"]));
    expect(parseAcceptanceContract(contract)).toEqual({ ok: true, value: contract });
    expect(contract.openQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "dependency-evidence-1", status: "open" }),
    ]));
    expect(contract.affectedCodebaseUnits).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(contract.goal).toContain("only after human confirmation");
  });

  it("has no unresolved evidence questions only when the proposal is complete", () => {
    expect(dependencyProposalToAcceptanceContract(proposal([])).openQuestions).toEqual([]);
  });
});
