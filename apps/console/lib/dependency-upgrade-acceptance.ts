import type { AcceptanceContract } from "@agentrail/contracts";
import type { DependencyUpgradeProposal } from "./dependency-upgrade-contract";

/**
 * Converts a dependency-watch proposal into the same draft contract used by
 * every other Jace intake. It deliberately does not approve, create an issue,
 * edit a dependency, choose a builder, or create a PR.
 */
export function dependencyProposalToAcceptanceContract(
  proposal: DependencyUpgradeProposal
): AcceptanceContract {
  const candidate = proposal.candidate;
  return {
    originalUserWording: proposal.title,
    goal: `Evaluate and, only after human confirmation, implement ${candidate.package} ${candidate.current_version} → ${candidate.target_version}.`,
    acceptanceCriteria: proposal.acceptanceCriteria.map((text, index) => ({
      id: `dependency-${index + 1}`,
      text,
      required: true,
      userVisible: false,
    })),
    nonGoals: proposal.nonGoals,
    risks: [
      "Release, usage, transitive/peer compatibility, security, or test evidence may be incomplete or stale.",
      "The candidate must remain bound to its observed baseline and fingerprint.",
    ],
    environmentExpectations: [
      `Observed baseline SHA: ${candidate.baseline_sha}.`,
      `Expected edit scope: ${proposal.expectedFiles.join(", ")}.`,
      ...proposal.verificationCommands.map((command) => `Verification command: ${command}`),
    ],
    stopConditions: proposal.stopConditions,
    affectedCodebaseUnits: proposal.expectedFiles,
    openQuestions: proposal.needsHumanDecision.map((text, index) => ({
      id: `dependency-evidence-${index + 1}`,
      text,
      status: "open" as const,
    })),
  };
}
