import { createHash } from "node:crypto";
import { composeAlignmentBrief } from "./alignment-brief";

export type DependencyUpgradeCandidateInput = {
  package: string;
  ecosystem?: string;
  package_manager?: string;
  package_manager_version?: string;
  dependency_kind: string;
  specifier: string;
  current_version: string;
  target_version: string;
  manifest_path: string;
  lockfile_path: string;
  baseline_sha: string;
  fingerprint: string;
  verification_commands?: string[];
  manager_commands?: {
    version?: string;
    install?: string;
    update?: string;
  };
};

export type DependencyUpgradeProposal = {
  title: string;
  whatToBuild: string;
  acceptanceCriteria: string[];
  releaseEvidence: string[];
  usageScope: string[];
  transitiveCompatibility: string;
  securityEvidence: string;
  baselineTests: string[];
  targetTests: string[];
  nonGoals: string[];
  expectedFiles: string[];
  stopConditions: string[];
  requiredProof: string[];
  verificationCommands: string[];
  candidateFingerprint: string;
  observationKey?: string;
  candidate: DependencyUpgradeCandidateInput;
  needsHumanDecision: string[];
  evidenceIssues?: string[];
};

export type DependencyUpgradeEvidenceInput = {
  releaseEvidence?: string[];
  usageScope?: string[];
  transitiveCompatibility?: string;
  security?: string;
  baselineTests?: string[];
  targetTests?: string[];
};

export type DependencyUpgradeProposalOptions = {
  observationKey?: string;
  evidenceIssues?: string[];
};

const MAX_FIELD = 240;

function clean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, MAX_FIELD);
}

function titleFor(candidate: DependencyUpgradeCandidateInput): string {
  return `Upgrade ${clean(candidate.package)} from ${clean(candidate.current_version)} to ${clean(candidate.target_version)}`;
}

function cleanList(values: string[] | undefined): string[] {
  return (values ?? []).map(clean).filter(Boolean);
}

/** Byte-compatible with the manager-neutral candidate fingerprint. */
export function computeDependencyCandidateFingerprint(candidate: DependencyUpgradeCandidateInput): string {
  const payloadObject: Record<string, unknown> = {
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  };
  if (candidate.package_manager) payloadObject.package_manager = candidate.package_manager;
  const payload = JSON.stringify(payloadObject);
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

export function candidateFingerprintMatches(candidate: DependencyUpgradeCandidateInput): boolean {
  return candidate.fingerprint === computeDependencyCandidateFingerprint(candidate);
}

export function buildDependencyUpgradeProposal(
  candidate: DependencyUpgradeCandidateInput,
  evidence: DependencyUpgradeEvidenceInput = {},
  options: DependencyUpgradeProposalOptions = {}
): DependencyUpgradeProposal {
  const packageName = clean(candidate.package);
  const current = clean(candidate.current_version);
  const target = clean(candidate.target_version);
  const fingerprint = clean(candidate.fingerprint);
  const observationKey = options.observationKey ? clean(options.observationKey) : undefined;
  const manifest = clean(candidate.manifest_path);
  const lockfile = clean(candidate.lockfile_path);

  const releaseEvidence = evidence.releaseEvidence?.length ? cleanList(evidence.releaseEvidence) : [
    `${clean(candidate.package_manager ?? "Repository package manager")} registry metadata identifies ${packageName}@${target} as newer than the locked ${current}.`,
    `Evidence baseline is commit ${clean(candidate.baseline_sha)}; it must still match before execution.`,
    "Release notes and security advisories are required proof before dependency edits; this proposal does not invent them.",
  ];
  const usageScope = evidence.usageScope?.length ? cleanList(evidence.usageScope) : [
    `Direct ${clean(candidate.dependency_kind)} entry ${packageName} in ${manifest}.`,
    `The requested scope is this package only; transitive packages are evidence, not extra edit targets.`,
  ];
  const nonGoals = [
    "No dependency installation, manifest edit, lockfile edit, or pull request is performed by proposal approval itself.",
    "No unrelated package, workspace, formatting, or application refactor is in scope.",
  ];
  const expectedFiles = [manifest, lockfile];
  const stopConditions = [
    "Baseline commit or candidate fingerprint no longer matches the observed candidate.",
    "Release, usage, transitive, peer, or security evidence is missing or ambiguous.",
    "The proposed diff needs files outside the manifest, lockfile, and directly required test fixtures.",
    "A declared baseline or target verification command fails.",
  ];
  const requiredProof = [
    "Release evidence with a canonical source and target version.",
    "Usage impact for direct imports and the selected codebase unit.",
    "Transitive and peer compatibility evidence from the target lock resolution.",
    "Security advisory result, including an explicit unknown/fail-closed result.",
    "Baseline and target test commands with their outputs.",
    `A scope diff limited to ${manifest}, ${lockfile}, and explicitly required tests.`,
    "Red-green and independent-verification evidence for the resulting issue.",
  ];
  const verificationCommands = candidate.verification_commands?.length
    ? cleanList(candidate.verification_commands)
    : [
        candidate.manager_commands?.install ?? "repository-declared frozen install",
        "repository-declared verification command",
      ];
  const acceptanceCriteria = [
    "Release evidence names the canonical release source, current version, and target version.",
    "Usage impact identifies direct imports, dependency kind, and affected codebase unit; unknown usage stops the work.",
    "Transitive and peer compatibility is checked against the target lock resolution and failures stop the work.",
    "Security evidence is recorded; an unavailable or ambiguous advisory result is treated as a stop condition.",
    "Baseline tests and target tests are both run and their commands and results are attached.",
    `The diff is scoped to ${manifest}, ${lockfile}, and explicitly required tests; unrelated changes stop the work.`,
    "The issue carries the candidate fingerprint, required proof, and independent-verification evidence.",
  ];

  const needsHumanDecision: string[] = [];
  if (!evidence.releaseEvidence?.some((item) => /^https:\/\//.test(item) && item.includes(target))) {
    needsHumanDecision.push("canonical release evidence is missing");
  }
  if (!evidence.usageScope?.length) needsHumanDecision.push("usage scope evidence is missing");
  if (!evidence.transitiveCompatibility?.trim()) needsHumanDecision.push("transitive compatibility evidence is missing");
  if (!evidence.security?.trim() || /unknown|unavailable|ambiguous/i.test(evidence.security)) {
    needsHumanDecision.push("security evidence is missing or inconclusive");
  }
  if (!evidence.baselineTests?.length || !evidence.targetTests?.length) {
    needsHumanDecision.push("baseline and target test commands are missing");
  }
  if (options.evidenceIssues?.length) {
    needsHumanDecision.push(...cleanList(options.evidenceIssues));
  }

  return {
    title: titleFor(candidate),
    whatToBuild: `Prepare a reviewable dependency-upgrade issue for ${packageName}: ${current} → ${target}. Do not edit dependencies during proposal creation. Candidate fingerprint: ${fingerprint}.`,
    acceptanceCriteria,
    releaseEvidence,
    usageScope,
    transitiveCompatibility: clean(evidence.transitiveCompatibility ?? ""),
    securityEvidence: clean(evidence.security ?? ""),
    baselineTests: cleanList(evidence.baselineTests),
    targetTests: cleanList(evidence.targetTests),
    nonGoals,
    expectedFiles,
    stopConditions,
    requiredProof,
    verificationCommands,
    candidateFingerprint: fingerprint,
    observationKey,
    candidate,
    needsHumanDecision,
    evidenceIssues: cleanList(options.evidenceIssues),
  };
}

export function dependencyUpgradeApprovalReady(proposal: DependencyUpgradeProposal): boolean {
  return proposal.needsHumanDecision.length === 0;
}

export function dependencyUpgradeProposalMatchesCandidate(
  proposal: DependencyUpgradeProposal,
  candidate: DependencyUpgradeCandidateInput
): boolean {
  return (
    proposal.candidateFingerprint === candidate.fingerprint &&
    proposal.candidate.fingerprint === candidate.fingerprint &&
    JSON.stringify(proposal.candidate) === JSON.stringify(candidate) &&
    candidateFingerprintMatches(candidate)
  );
}

export function buildDependencyUpgradeIssueBody(proposal: DependencyUpgradeProposal): string {
  const list = (items: string[]) => items.map((item) => `- ${clean(item)}`).join("\n");
  const criteria = proposal.acceptanceCriteria
    .map((item, index) => `- [ ] AC${index + 1}: ${clean(item)}`)
    .join("\n");
  return [
    "## Parent",
    "Observed dependency candidate converted through Jace's human alignment gate.",
    "",
    "## Required context",
    `Candidate fingerprint: ${clean(proposal.candidateFingerprint)}`,
    `Package: ${clean(proposal.candidate.package)} (${clean(proposal.candidate.dependency_kind)})`,
    `Observation key: ${clean(proposal.observationKey ?? "unavailable")}`,
    `Ecosystem: ${clean(proposal.candidate.ecosystem ?? "unknown")}`,
    `Package manager: ${clean(proposal.candidate.package_manager ?? "repository-declared")}`,
    `Version: ${clean(proposal.candidate.current_version)} → ${clean(proposal.candidate.target_version)}`,
    `Baseline SHA: ${clean(proposal.candidate.baseline_sha)}`,
    `Expected files: ${list(proposal.expectedFiles)}`,
    "",
    "## What to build",
    clean(proposal.whatToBuild),
    "",
    "## Release evidence",
    list(proposal.releaseEvidence),
    "",
    "## Usage scope",
    list(proposal.usageScope),
    "",
    "## Transitive and peer compatibility",
    clean(proposal.transitiveCompatibility || "Evidence required before approval."),
    "",
    "## Security evidence",
    clean(proposal.securityEvidence || "Evidence required before approval."),
    ...(proposal.evidenceIssues?.length
      ? [
          "",
          "## Evidence issues",
          list(proposal.evidenceIssues),
        ]
      : []),
    "",
    "## Non-goals",
    list(proposal.nonGoals),
    "",
    "## Stop conditions",
    list(proposal.stopConditions),
    "",
    "## Required proof",
    list(proposal.requiredProof),
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Verification evidence",
    `Baseline commands: ${proposal.baselineTests.map(clean).join("; ") || "required"}`,
    `Target commands: ${proposal.targetTests.map(clean).join("; ") || "required"}`,
    `Commands: ${proposal.verificationCommands.map(clean).join("; ")}`,
    "Baseline and target results must be recorded by the implementer; no result is assumed by this proposal.",
  ].join("\n");
}

export function buildDependencyUpgradeApprovalInput(
  contractId: string,
  proposal: DependencyUpgradeProposal
): Record<string, unknown> {
  const issueBody = buildDependencyUpgradeIssueBody(proposal);
  const alignmentBrief = composeAlignmentBrief({
    title: proposal.title,
    body: issueBody,
    repoFullName: "",
    issueNumber: 0,
    issueUrl: "",
  });
  return {
    contractId,
    title: proposal.title,
    whatToBuild: proposal.whatToBuild,
    acceptanceCriteria: proposal.acceptanceCriteria,
    taskType: alignmentBrief.taskType,
    suggestedModel: alignmentBrief.suggestedModel,
    estimateUsd: alignmentBrief.estimateUsd,
    assumptions: [
      ...alignmentBrief.assumptions,
      "Approval creates only the house-format issue; dependency edits and PR creation remain future execution work.",
    ],
    candidateFingerprint: proposal.candidateFingerprint,
    releaseEvidence: proposal.releaseEvidence,
    usageScope: proposal.usageScope,
    transitiveCompatibility: proposal.transitiveCompatibility,
    securityEvidence: proposal.securityEvidence,
    baselineTests: proposal.baselineTests,
    targetTests: proposal.targetTests,
    nonGoals: proposal.nonGoals,
    expectedFiles: proposal.expectedFiles,
    stopConditions: proposal.stopConditions,
    requiredProof: proposal.requiredProof,
    verificationCommands: proposal.verificationCommands,
    observationKey: proposal.observationKey,
    proposal,
    candidate: proposal.candidate,
    _brief: alignmentBrief,
  };
}
