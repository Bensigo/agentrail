import type { AcceptanceContract } from "@agentrail/contracts";
import type { DependencyUpgradeProposal } from "./dependency-upgrade-contract";

export function dependencyProposalFromUnknown(value: unknown): DependencyUpgradeProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const proposal = value as Record<string, unknown>;
  const candidate = proposal.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const strings = ["title", "candidateFingerprint"];
  if (strings.some((key) => typeof proposal[key] !== "string" || !(proposal[key] as string).trim())) return null;
  const arrays = ["acceptanceCriteria", "nonGoals", "expectedFiles", "stopConditions", "verificationCommands", "needsHumanDecision"];
  if (arrays.some((key) => !Array.isArray(proposal[key]) || (proposal[key] as unknown[]).some((item) => typeof item !== "string" || !item.trim()))) return null;
  const requiredCandidate = ["package", "current_version", "target_version", "baseline_sha"];
  if (requiredCandidate.some((key) => typeof (candidate as Record<string, unknown>)[key] !== "string" || !((candidate as Record<string, unknown>)[key] as string).trim())) return null;
  return proposal as unknown as DependencyUpgradeProposal;
}

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
