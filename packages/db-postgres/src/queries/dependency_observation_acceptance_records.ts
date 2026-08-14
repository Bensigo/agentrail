import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  acceptanceContracts,
  changeRecordEvents,
  changeRecords,
  dependencyWatchObservations,
  dependencyWatches,
  repositories,
} from "../schema/index.js";
import type { ChangeRecordEventRow } from "../schema/change_records.js";
import {
  acceptanceContractId,
  changeRecordEventId,
  changeRecordId,
  type AcceptanceRecordDraft,
} from "./change_records.js";
import {
  type DependencyUpgradeCandidate,
} from "./dependency_upgrade_contracts.js";
import { validateGoDependencySourceInventoryReceipt } from "./dependency_watches.js";

const ACTOR = "server:dependency-observation-proposal";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const FILE_SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const GO_MODULE = /^(?=.{1,512}$)[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?)+$/u;
const GO_VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const NPM_PRERELEASE_IDENTIFIER = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const NPM_PRERELEASE = `${NPM_PRERELEASE_IDENTIFIER}(?:\\.${NPM_PRERELEASE_IDENTIFIER})*`;
const NPM_BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const NPM_VERSION_TEXT = `v?(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-${NPM_PRERELEASE})?(?:\\+${NPM_BUILD})?`;
const NPM_VERSION = new RegExp(
  `^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${NPM_PRERELEASE}))?(?:\\+${NPM_BUILD})?$`,
);
const NPM_COMPARATOR = new RegExp(`^(<=|>=|<|>|=)?(${NPM_VERSION_TEXT})$`);
const NPM_HYPHEN = new RegExp(`^(${NPM_VERSION_TEXT})\\s+-\\s+(${NPM_VERSION_TEXT})$`);
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const UNSAFE_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/i;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?|npm):/i;
const BIDI_OR_CONTROL = /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_SELECTED_FILE_HASHES = 16;

export const dependencyObservationDraftErrorCodes = [
  "not_found", "unsupported_manager", "unsafe_custody", "conflict",
] as const;
export type DependencyObservationDraftErrorCode =
  (typeof dependencyObservationDraftErrorCodes)[number];

export class DependencyObservationDraftError extends Error {
  constructor(readonly code: DependencyObservationDraftErrorCode, message: string) {
    super(message);
    this.name = "DependencyObservationDraftError";
  }
}

/** This is intentionally the entire public authority surface. */
export type CreateDraftAcceptanceRecordFromDependencyObservationInput = {
  workspaceId: string;
  watchId: string;
  candidateFingerprint: string;
};

/**
 * The only proposal profiles admitted by this persistence boundary.
 * Detection, a lockfile name, or a command template cannot add an entry.
 */
export const dependencyObservationProposalProfileRegistry = {
  "node:pnpm": {
    profile: {
      ecosystem: "node",
      manager: "pnpm",
      profile: "pnpm_lockfile_only_v1",
      capability: "proposal_observation_only",
    },
    manifestPath: "package.json",
    lockfilePath: "pnpm-lock.yaml",
  },
  "node:npm": {
    profile: {
      ecosystem: "node",
      manager: "npm",
      profile: "npm_package_lock_only_v1",
      capability: "proposal_observation_only",
    },
    manifestPath: "package.json",
    lockfilePath: "package-lock.json",
  },
  "go:go-modules": {
    profile: {
      ecosystem: "go",
      manager: "go-modules",
      profile: "go_root_public_proxy_lock_v1",
      capability: "proposal_observation_only",
    },
    manifestPath: "go.mod",
    lockfilePath: "go.sum",
  },
} as const;

type ProposalProfileDefinition =
  (typeof dependencyObservationProposalProfileRegistry)[keyof typeof dependencyObservationProposalProfileRegistry];
export type DependencyObservationProposalProfile = ProposalProfileDefinition["profile"];

export type DependencyObservationAcceptanceRecordDraft = AcceptanceRecordDraft & {
  event: ChangeRecordEventRow;
  observation: { id: string; key: string };
  profile: DependencyObservationProposalProfile;
  created: boolean;
};

type LegacyObservationProposalCandidate<
  Ecosystem extends "node" | "go",
  Manager extends "pnpm" | "npm" | "go-modules",
  VerificationCommands extends string[],
> = Omit<
  DependencyUpgradeCandidate,
  | "ecosystem"
  | "package_manager"
  | "package_manager_version"
  | "verification_commands"
  | "manager_commands"
> & {
  ecosystem: Ecosystem;
  package_manager: Manager;
  package_manager_version: null;
  verification_commands: VerificationCommands;
  manager_commands: { version: string; install: string; update: string };
};

type PnpmObservationProposalCandidate = LegacyObservationProposalCandidate<
  "node",
  "pnpm",
  [string, string]
>;
type NpmObservationProposalCandidate = LegacyObservationProposalCandidate<
  "node",
  "npm",
  [string]
>;
type GoModulesObservationProposalCandidate = LegacyObservationProposalCandidate<
  "go",
  "go-modules",
  [string, string]
>;
export type DependencyObservationProposalCandidate =
  | PnpmObservationProposalCandidate
  | NpmObservationProposalCandidate
  | GoModulesObservationProposalCandidate;

export type DependencyObservationSelectedFileHashes =
  | { "package.json": string; "pnpm-lock.yaml": string }
  | { "package.json": string; "package-lock.json": string }
  | { "go.mod": string; "go.sum": string };

type Custody = {
  watchId: string;
  repositoryId: string;
  repositoryName: string;
  observationId: string;
  observationKey: string;
  baselineSha: string;
  manifestPath: "package.json" | "go.mod";
  lockfilePath: "pnpm-lock.yaml" | "package-lock.json" | "go.sum";
  selectedFileHashes: DependencyObservationSelectedFileHashes;
  candidate: DependencyObservationProposalCandidate;
  profile: DependencyObservationProposalProfile;
  sourceInventoryReceiptSha256: string | null;
};
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function exactLocator(input: unknown): input is CreateDraftAcceptanceRecordFromDependencyObservationInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return Object.keys(value).length === 3
    && Object.keys(value).every((key) => key === "workspaceId" || key === "watchId" || key === "candidateFingerprint")
    && UUID.test(value.workspaceId as string)
    && UUID.test(value.watchId as string)
    && SHA256.test(value.candidateFingerprint as string);
}

function safeText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !BIDI_OR_CONTROL.test(value);
}

function safePath(value: unknown): value is string {
  return safeText(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

type NpmSemver = {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: Array<bigint | string>;
};

function parseNpmSemver(value: unknown): NpmSemver | null {
  if (typeof value !== "string") return null;
  const match = NPM_VERSION.exec(value.trim());
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^[0-9]+$/.test(part) ? BigInt(part) : part)
    : [];
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease,
  };
}

function compareNpmSemver(left: NpmSemver, right: NpmSemver): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = left.prerelease[index]!;
    const rightPart = right.prerelease[index]!;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "bigint" && typeof rightPart === "string") return -1;
    if (typeof leftPart === "string" && typeof rightPart === "bigint") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

function sameNpmSemverCore(left: NpmSemver, right: NpmSemver): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function npmPrereleaseIsAdmitted(actual: NpmSemver, prereleaseCores: NpmSemver[]): boolean {
  return actual.prerelease.length === 0
    || prereleaseCores.some((expected) => sameNpmSemverCore(actual, expected));
}

type NpmWildcardBounds = { lower: NpmSemver | null; upper: NpmSemver | null };

function npmWildcardBounds(text: string): NpmWildcardBounds | null {
  if (["*", "x", "X"].includes(text)) return { lower: null, upper: null };
  const parts = text.split(".");
  const wildcard = (part: string) => ["*", "x", "X"].includes(part);
  if (parts.length < 1 || parts.length > 3
    || parts.some((part) => !wildcard(part) && !/^(?:0|[1-9][0-9]*)$/.test(part))) return null;
  if (wildcard(parts[0]!)) return { lower: null, upper: null };
  const major = BigInt(parts[0]!);
  if (parts.length === 1 || wildcard(parts[1]!)) {
    return {
      lower: { major, minor: 0n, patch: 0n, prerelease: [] },
      upper: { major: major + 1n, minor: 0n, patch: 0n, prerelease: [] },
    };
  }
  const minor = BigInt(parts[1]!);
  if (parts.length === 2 || wildcard(parts[2]!)) {
    return {
      lower: { major, minor, patch: 0n, prerelease: [] },
      upper: { major, minor: minor + 1n, patch: 0n, prerelease: [] },
    };
  }
  return null;
}

function npmComparatorMatches(operator: string, actual: NpmSemver, expected: NpmSemver): boolean {
  const comparison = compareNpmSemver(actual, expected);
  if (operator === "=") return comparison === 0;
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  if (operator === "<") return comparison < 0;
  return operator === "<=" && comparison <= 0;
}

function npmConstraintBranchMatches(branch: string, actual: NpmSemver): boolean | null {
  const hyphen = NPM_HYPHEN.exec(branch);
  if (hyphen) {
    const lower = parseNpmSemver(hyphen[1]);
    const upper = parseNpmSemver(hyphen[2]);
    if (!lower || !upper) return null;
    const prereleaseCores = [lower, upper].filter((version) => version.prerelease.length > 0);
    return compareNpmSemver(actual, lower) >= 0
      && compareNpmSemver(actual, upper) <= 0
      && npmPrereleaseIsAdmitted(actual, prereleaseCores);
  }

  if (branch.startsWith("^") || branch.startsWith("~")) {
    if (branch.includes(" ")) return null;
    const lower = parseNpmSemver(branch.slice(1));
    if (!lower) return null;
    const upper = branch[0] === "~"
      ? { major: lower.major, minor: lower.minor + 1n, patch: 0n, prerelease: [] }
      : lower.major > 0n
        ? { major: lower.major + 1n, minor: 0n, patch: 0n, prerelease: [] }
        : lower.minor > 0n
          ? { major: 0n, minor: lower.minor + 1n, patch: 0n, prerelease: [] }
          : { major: 0n, minor: 0n, patch: lower.patch + 1n, prerelease: [] };
    return compareNpmSemver(actual, lower) >= 0
      && compareNpmSemver(actual, upper) < 0
      && npmPrereleaseIsAdmitted(actual, lower.prerelease.length > 0 ? [lower] : []);
  }

  const wildcard = npmWildcardBounds(branch);
  if (wildcard) {
    const matches = wildcard.lower === null
      || (compareNpmSemver(actual, wildcard.lower) >= 0
        && wildcard.upper !== null
        && compareNpmSemver(actual, wildcard.upper) < 0);
    return matches && npmPrereleaseIsAdmitted(actual, []);
  }

  const tokens = branch.split(/\s+/u);
  if (tokens.length === 0) return null;
  const comparators: Array<{ operator: string; expected: NpmSemver }> = [];
  for (const token of tokens) {
    const match = NPM_COMPARATOR.exec(token);
    if (!match || (tokens.length > 1 && !match[1])) return null;
    const expected = parseNpmSemver(match[2]);
    if (!expected) return null;
    comparators.push({ operator: match[1] ?? "=", expected });
  }
  const prereleaseCores = comparators
    .map(({ expected }) => expected)
    .filter((expected) => expected.prerelease.length > 0);
  return comparators.every(({ operator, expected }) => npmComparatorMatches(operator, actual, expected))
    && npmPrereleaseIsAdmitted(actual, prereleaseCores);
}

/** Exact conservative subset admitted by the merged Python npm producer. */
export function npmObservationConstraintMatches(specifier: unknown, version: unknown): boolean | null {
  const actual = parseNpmSemver(version);
  if (!actual || typeof specifier !== "string" || !specifier.trim()) return null;
  const branches = specifier.trim().split("||").map((branch) => branch.trim());
  if (branches.some((branch) => !branch)) return null;
  let anyMatch = false;
  for (const branch of branches) {
    const matches = npmConstraintBranchMatches(branch, actual);
    if (matches === null) return null;
    anyMatch ||= matches;
  }
  return anyMatch;
}

function npmTargetIsNewer(current: string, target: string): boolean {
  const currentVersion = parseNpmSemver(current);
  const targetVersion = parseNpmSemver(target);
  return !!currentVersion && !!targetVersion
    && targetVersion.prerelease.length === 0
    && compareNpmSemver(currentVersion, targetVersion) < 0;
}

/**
 * Observation writers may hash a bounded set of selected files. This proposal
 * profile admits only the two files it understands, so unrelated hashes never
 * become Record custody or alter the canonical identity.
 */
function selectedHashes(
  value: unknown,
  definition: {
    manifestPath: "package.json" | "go.mod";
    lockfilePath: "pnpm-lock.yaml" | "package-lock.json" | "go.sum";
  },
): DependencyObservationSelectedFileHashes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 2 || entries.length > MAX_SELECTED_FILE_HASHES
    || !entries.every(([path, hash]) => safePath(path) && typeof hash === "string" && FILE_SHA256.test(hash))) return null;
  const manifest = (value as Record<string, unknown>)[definition.manifestPath];
  const lockfile = (value as Record<string, unknown>)[definition.lockfilePath];
  if (typeof manifest !== "string" || typeof lockfile !== "string"
    || !FILE_SHA256.test(manifest) || !FILE_SHA256.test(lockfile)) return null;
  return definition.lockfilePath === "pnpm-lock.yaml"
    ? { "package.json": manifest, "pnpm-lock.yaml": lockfile }
    : definition.lockfilePath === "package-lock.json"
      ? { "package.json": manifest, "package-lock.json": lockfile }
      : { "go.mod": manifest, "go.sum": lockfile };
}

const LEGACY_CANDIDATE_KEYS = [
  "package", "ecosystem", "package_manager", "dependency_kind", "specifier",
  "current_version", "target_version", "manifest_path", "lockfile_path",
  "baseline_sha", "fingerprint", "package_manager_version",
  "verification_commands", "manager_commands",
] as const;

function candidateRaw(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === LEGACY_CANDIDATE_KEYS.length
    && keys.every((key) => (LEGACY_CANDIDATE_KEYS as readonly string[]).includes(key));
}

function candidateWithFingerprint(value: unknown, fingerprint: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).fingerprint === fingerprint;
}

function profileDefinition(value: unknown): ProposalProfileDefinition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.ecosystem === "node" && raw.package_manager === "pnpm") {
    return dependencyObservationProposalProfileRegistry["node:pnpm"];
  }
  if (raw.ecosystem === "node" && raw.package_manager === "npm") {
    return dependencyObservationProposalProfileRegistry["node:npm"];
  }
  if (raw.ecosystem === "go" && raw.package_manager === "go-modules") {
    return dependencyObservationProposalProfileRegistry["go:go-modules"];
  }
  return null;
}

/**
 * Byte-compatible with agentrail/dependencies/pnpm.py:_make_candidate.
 * Python serializes the fingerprint payload with sorted keys and compact JSON;
 * keep this explicit order so a real heartbeat candidate is not mistaken for
 * forged custody.
 */
export function pnpmObservationCandidateFingerprint(
  candidate: Pick<
    DependencyUpgradeCandidate,
    | "baseline_sha"
    | "current_version"
    | "dependency_kind"
    | "lockfile_path"
    | "manifest_path"
    | "package"
    | "specifier"
    | "target_version"
  >,
): string {
  return stableSha256({
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    package_manager: "pnpm",
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  });
}

/** Byte-compatible with observation.py:_make_candidate for the npm profile. */
export function npmObservationCandidateFingerprint(
  candidate: Pick<
    DependencyUpgradeCandidate,
    | "baseline_sha"
    | "current_version"
    | "dependency_kind"
    | "lockfile_path"
    | "manifest_path"
    | "package"
    | "specifier"
    | "target_version"
  >,
): string {
  return stableSha256({
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    package_manager: "npm",
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  });
}

/** Byte-compatible with observation.py:_make_candidate for the Go Modules profile. */
export function goModulesObservationCandidateFingerprint(
  candidate: Pick<
    DependencyUpgradeCandidate,
    | "baseline_sha"
    | "current_version"
    | "dependency_kind"
    | "lockfile_path"
    | "manifest_path"
    | "package"
    | "specifier"
    | "target_version"
  >,
): string {
  return stableSha256({
    baseline_sha: candidate.baseline_sha,
    current_version: candidate.current_version,
    dependency_kind: candidate.dependency_kind,
    lockfile_path: candidate.lockfile_path,
    manifest_path: candidate.manifest_path,
    package: candidate.package,
    package_manager: "go-modules",
    specifier: candidate.specifier,
    target_version: candidate.target_version,
  });
}

function goVersionParts(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = GO_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : null;
}

function goModuleMajor(modulePath: string): number | null {
  const first = modulePath.split("/", 1)[0]!;
  if (!first.includes(".") || /^\d+(?:\.\d+){3}$/u.test(first)) return null;
  const slash = /\/v([2-9][0-9]*)$/u.exec(modulePath);
  if (slash) return Number(slash[1]);
  const gopkg = /^gopkg\.in\/.+\.v([1-9][0-9]*)$/u.exec(modulePath);
  return gopkg ? Number(gopkg[1]) : 0;
}

/** Parse only the public root Go profile emitted by the live watcher. */
export function validateGoModulesObservationProposalCandidate(
  value: unknown,
): GoModulesObservationProposalCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!candidateRaw(raw) || LEGACY_CANDIDATE_KEYS.some((key) => !(key in raw))) return null;
  if (raw.ecosystem !== "go" || raw.package_manager !== "go-modules"
    || raw.package_manager_version !== null
    || !safeText(raw.package) || !GO_MODULE.test(raw.package)
    || raw.package !== raw.package.toLowerCase()
    || raw.dependency_kind !== "dependencies"
    || raw.specifier !== raw.current_version
    || raw.manifest_path !== "go.mod" || raw.lockfile_path !== "go.sum"
    || typeof raw.baseline_sha !== "string" || !GIT_SHA.test(raw.baseline_sha)
    || typeof raw.fingerprint !== "string" || !SHA256.test(raw.fingerprint)) return null;
  const current = goVersionParts(raw.current_version);
  const target = goVersionParts(raw.target_version);
  const moduleMajor = goModuleMajor(raw.package);
  if (!current || !target || moduleMajor === null
    || current[0] !== target[0]
    || (moduleMajor === 0 ? current[0] > 1 : current[0] !== moduleMajor)
    || compareNpmSemver(
      { major: BigInt(current[0]), minor: BigInt(current[1]), patch: BigInt(current[2]), prerelease: [] },
      { major: BigInt(target[0]), minor: BigInt(target[1]), patch: BigInt(target[2]), prerelease: [] },
    ) >= 0) return null;

  const commands = raw.manager_commands;
  const verification = raw.verification_commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)
    || !Array.isArray(verification)) return null;
  const commandRecord = commands as Record<string, unknown>;
  if (Object.keys(commandRecord).length !== 3
    || commandRecord.version !== "go version"
    || commandRecord.install !== "go mod download"
    || commandRecord.update !== `go get ${raw.package}@${raw.target_version}`
    || verification.length !== 2
    || verification[0] !== "go mod download"
    || verification[1] !== "go test ./...") return null;

  const candidate: GoModulesObservationProposalCandidate = {
    package: raw.package,
    ecosystem: "go",
    package_manager: "go-modules",
    package_manager_version: null,
    dependency_kind: "dependencies",
    specifier: raw.specifier as string,
    current_version: raw.current_version as string,
    target_version: raw.target_version as string,
    manifest_path: "go.mod",
    lockfile_path: "go.sum",
    baseline_sha: raw.baseline_sha,
    fingerprint: raw.fingerprint,
    verification_commands: [verification[0], verification[1]],
    manager_commands: {
      version: commandRecord.version as string,
      install: commandRecord.install as string,
      update: commandRecord.update as string,
    },
  };
  return goModulesObservationCandidateFingerprint(candidate) === candidate.fingerprint
    ? candidate
    : null;
}

/** Parse exactly the asdict shape serialized by the live pnpm watch producer. */
export function validatePnpmObservationProposalCandidate(
  value: unknown,
): PnpmObservationProposalCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!candidateRaw(raw) || LEGACY_CANDIDATE_KEYS.some((key) => !(key in raw))) return null;
  if (raw.ecosystem !== "node" || raw.package_manager !== "pnpm"
    || raw.package_manager_version !== null) return null;
  if (!safeText(raw.package) || !NPM_PACKAGE.test(raw.package)
    || !safeText(raw.dependency_kind) || !["dependencies", "devDependencies"].includes(raw.dependency_kind)
    || !safeText(raw.specifier) || UNSAFE_SPECIFIER.test(raw.specifier)
    || !safeText(raw.current_version) || !SEMVER.test(raw.current_version)
    || !safeText(raw.target_version) || !SEMVER.test(raw.target_version) || raw.target_version === raw.current_version
    || raw.manifest_path !== "package.json" || raw.lockfile_path !== "pnpm-lock.yaml"
    || typeof raw.baseline_sha !== "string" || !GIT_SHA.test(raw.baseline_sha)
    || typeof raw.fingerprint !== "string" || !SHA256.test(raw.fingerprint)) return null;

  const commands = raw.manager_commands;
  const verification = raw.verification_commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)
    || !Array.isArray(verification)) return null;
  const commandRecord = commands as Record<string, unknown>;
  const expectedUpdate = `pnpm update --lockfile-only --ignore-scripts ${raw.package}@${raw.target_version}`;
  if (Object.keys(commandRecord).length !== 3
    || commandRecord.version !== "pnpm --version"
    || commandRecord.install !== "pnpm install --frozen-lockfile"
    || commandRecord.update !== expectedUpdate
    || verification.length !== 2
    || verification[0] !== "pnpm install --frozen-lockfile"
    || verification[1] !== "pnpm test") return null;

  const candidate: PnpmObservationProposalCandidate = {
    package: raw.package,
    ecosystem: "node",
    package_manager: "pnpm",
    package_manager_version: null,
    dependency_kind: raw.dependency_kind,
    specifier: raw.specifier,
    current_version: raw.current_version,
    target_version: raw.target_version,
    manifest_path: "package.json",
    lockfile_path: "pnpm-lock.yaml",
    baseline_sha: raw.baseline_sha,
    fingerprint: raw.fingerprint,
    verification_commands: [verification[0], verification[1]],
    manager_commands: {
      version: commandRecord.version as string,
      install: commandRecord.install as string,
      update: commandRecord.update as string,
    },
  };
  return pnpmObservationCandidateFingerprint(candidate) === candidate.fingerprint ? candidate : null;
}

const NPM_SAVE_FLAGS = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  optionalDependencies: "--save-optional",
  peerDependencies: "--save-peer",
} as const;

/** Parse exactly the 14-key legacy payload persisted by the live npm watcher. */
export function validateNpmObservationProposalCandidate(
  value: unknown,
): NpmObservationProposalCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!candidateRaw(raw) || LEGACY_CANDIDATE_KEYS.some((key) => !(key in raw))) return null;
  if (raw.ecosystem !== "node" || raw.package_manager !== "npm"
    || raw.package_manager_version !== null) return null;
  if (!safeText(raw.package) || !NPM_PACKAGE.test(raw.package)
    || !safeText(raw.dependency_kind)
    || !Object.hasOwn(NPM_SAVE_FLAGS, raw.dependency_kind)
    || !safeText(raw.specifier) || UNSAFE_NPM_SPECIFIER.test(raw.specifier.trim())
    || !safeText(raw.current_version) || !SEMVER.test(raw.current_version)
    || !safeText(raw.target_version) || !SEMVER.test(raw.target_version)
    || !npmTargetIsNewer(raw.current_version, raw.target_version)
    || npmObservationConstraintMatches(raw.specifier, raw.current_version) !== true
    || npmObservationConstraintMatches(raw.specifier, raw.target_version) !== true
    || raw.manifest_path !== "package.json" || raw.lockfile_path !== "package-lock.json"
    || typeof raw.baseline_sha !== "string" || !GIT_SHA.test(raw.baseline_sha)
    || typeof raw.fingerprint !== "string" || !SHA256.test(raw.fingerprint)) return null;

  const commands = raw.manager_commands;
  const verification = raw.verification_commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)
    || !Array.isArray(verification)) return null;
  const commandRecord = commands as Record<string, unknown>;
  const saveFlag = NPM_SAVE_FLAGS[raw.dependency_kind as keyof typeof NPM_SAVE_FLAGS];
  const expectedUpdate = `npm install ${raw.package}@${raw.target_version} --package-lock-only --ignore-scripts --no-audit ${saveFlag}`;
  if (Object.keys(commandRecord).length !== 3
    || commandRecord.version !== "npm --version"
    || commandRecord.install !== "npm ci --ignore-scripts"
    || commandRecord.update !== expectedUpdate
    || verification.length !== 1
    || verification[0] !== "npm test") return null;

  const candidate: NpmObservationProposalCandidate = {
    package: raw.package,
    ecosystem: "node",
    package_manager: "npm",
    package_manager_version: null,
    dependency_kind: raw.dependency_kind,
    specifier: raw.specifier,
    current_version: raw.current_version,
    target_version: raw.target_version,
    manifest_path: "package.json",
    lockfile_path: "package-lock.json",
    baseline_sha: raw.baseline_sha,
    fingerprint: raw.fingerprint,
    verification_commands: [verification[0]],
    manager_commands: {
      version: commandRecord.version as string,
      install: commandRecord.install as string,
      update: commandRecord.update as string,
    },
  };
  return npmObservationCandidateFingerprint(candidate) === candidate.fingerprint ? candidate : null;
}

export type ResolvedDependencyObservationProposalCandidate = {
  candidate: DependencyObservationProposalCandidate;
  profile: DependencyObservationProposalProfile;
  manifestPath: "package.json" | "go.mod";
  lockfilePath: "pnpm-lock.yaml" | "package-lock.json" | "go.sum";
};

/** Resolve through the closed registry; an unknown manager is never coerced to npm. */
export function resolveDependencyObservationProposalCandidate(
  value: unknown,
): ResolvedDependencyObservationProposalCandidate | null {
  const definition = profileDefinition(value);
  if (!definition) return null;
  const candidate = definition.profile.manager === "pnpm"
    ? validatePnpmObservationProposalCandidate(value)
    : definition.profile.manager === "npm"
      ? validateNpmObservationProposalCandidate(value)
      : validateGoModulesObservationProposalCandidate(value);
  return candidate ? { candidate, ...definition } : null;
}

function stableSha256(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/** Every field that can distinguish custody participates in the deterministic record key. */
function custodyIdentity(custody: Custody): string {
  return stableSha256({
    kind: "dependency_observation_proposal_custody",
    version: 1,
    profile: custody.profile,
    repository: { id: custody.repositoryId, name: custody.repositoryName },
    watchId: custody.watchId,
    observation: { id: custody.observationId, key: custody.observationKey },
    baselineSha: custody.baselineSha,
    selectedFileHashes: custody.selectedFileHashes,
    candidate: custody.candidate,
    ...(custody.sourceInventoryReceiptSha256 === null
      ? {}
      : { sourceInventoryReceiptSha256: custody.sourceInventoryReceiptSha256 }),
  });
}

/**
 * Recompute the immutable proposal identity from persisted source custody.
 * Readers use this instead of trusting the stored digest to be self-authenticating.
 */
export function dependencyObservationProposalCustodyIdentity(input: {
  repositoryId: string;
  repositoryName: string;
  watchId: string;
  observationId: string;
  observationKey: string;
  baselineSha: string;
  selectedFileHashes: Record<string, string>;
  candidate: unknown;
  sourceInventoryReceiptSha256?: string | null;
}): string | null {
  const resolved = resolveDependencyObservationProposalCandidate(input.candidate);
  const hashes = resolved ? selectedHashes(input.selectedFileHashes, resolved) : null;
  if (!resolved || !hashes || Object.keys(input.selectedFileHashes).length !== 2
    || !UUID.test(input.repositoryId) || !safeText(input.repositoryName)
    || !UUID.test(input.watchId) || !UUID.test(input.observationId)
    || !safeText(input.observationKey) || !GIT_SHA.test(input.baselineSha)
    || resolved.candidate.baseline_sha !== input.baselineSha) return null;
  const sourceInventoryReceiptSha256 = input.sourceInventoryReceiptSha256 ?? null;
  if (resolved.profile.manager === "go-modules"
    ? !FILE_SHA256.test(sourceInventoryReceiptSha256 ?? "")
    : sourceInventoryReceiptSha256 !== null) return null;
  return custodyIdentity({
    repositoryId: input.repositoryId,
    repositoryName: input.repositoryName,
    watchId: input.watchId,
    observationId: input.observationId,
    observationKey: input.observationKey,
    baselineSha: input.baselineSha,
    manifestPath: resolved.manifestPath,
    lockfilePath: resolved.lockfilePath,
    selectedFileHashes: hashes,
    candidate: resolved.candidate,
    profile: resolved.profile,
    sourceInventoryReceiptSha256,
  });
}

function sourceReferences(custody: Custody, proposalCustodyIdentity: string): Record<string, unknown>[] {
  return [{
    kind: "dependency_watch_observation_proposal", version: 1,
    repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
    watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
    candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity,
    candidate: custody.candidate, baselineSha: custody.baselineSha,
    manifestPath: custody.manifestPath, lockfilePath: custody.lockfilePath, selectedFileHashes: custody.selectedFileHashes,
    ...(custody.sourceInventoryReceiptSha256 === null ? {} : {
      sourceInventoryReceiptSha256: custody.sourceInventoryReceiptSha256,
    }),
    profile: custody.profile, repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
  }];
}

function contract(custody: Custody, proposalCustodyIdentity: string): Record<string, unknown> {
  const unresolved = [
    "release",
    "usage",
    "runtime",
    "target-lock",
    "security",
    "human-confirmation",
    "approval",
    "context-pack",
    "builder-handoff",
    ...(custody.profile.manager === "npm" ? ["delivery", "pull-request", "merge"] : []),
  ];
  return {
    originalRequest: `Assess observed dependency candidate ${custody.candidate.package} from ${custody.candidate.current_version} to ${custody.candidate.target_version}.`,
    normalizedRequirements: [
      "This is a draft-only dependency proposal with server-derived observation custody.",
      "No confirmation, approval, Context Pack, route, issue, pull request, queue, execution, or delivery is authorized.",
    ],
    acceptanceCriteria: [{
      id: "DEP-PROPOSAL-CUSTODY",
      text: "Watch-observation proposal custody remains exact and grants no delivery authority.",
      userVisible: false,
    }],
    nonGoals: ["No dependency change or operational handoff."],
    risks: unresolved.map((kind) => `${kind} evidence is unresolved and blocking.`),
    environment: {
      kind: "dependency_watch_observation_proposal", admission: "draft_only", profile: custody.profile,
      repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
      watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
      candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity, candidate: custody.candidate,
      baselineSha: custody.baselineSha, manifestPath: custody.manifestPath, lockfilePath: custody.lockfilePath,
      selectedFileHashes: custody.selectedFileHashes,
      ...(custody.sourceInventoryReceiptSha256 === null ? {} : {
        sourceInventoryReceiptSha256: custody.sourceInventoryReceiptSha256,
      }),
      repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
    },
    stops: unresolved.map((kind) => `${kind} evidence remains unresolved.`),
    unresolvedQuestions: unresolved.map((kind) => ({ id: `dependency-${kind}-evidence`, text: `${kind} evidence has not been admitted.` })),
  };
}

function payload(custody: Custody, recordId: string, contractId: string, proposalCustodyIdentity: string): Record<string, unknown> {
  return {
    kind: "dependency_observation_proposal_draft", version: 1, recordId,
    acceptanceContractId: contractId, acceptanceContractVersion: 1,
    repositoryId: custody.repositoryId, repositoryName: custody.repositoryName,
    watchId: custody.watchId, observationId: custody.observationId, observationKey: custody.observationKey,
    candidateFingerprint: custody.candidate.fingerprint, proposalCustodyIdentity, candidate: custody.candidate,
    profile: custody.profile, baselineSha: custody.baselineSha, manifestPath: custody.manifestPath, lockfilePath: custody.lockfilePath,
    selectedFileHashes: custody.selectedFileHashes, evidenceAdmission: "unresolved", authority: "draft_only",
    ...(custody.sourceInventoryReceiptSha256 === null ? {} : {
      sourceInventoryReceiptSha256: custody.sourceInventoryReceiptSha256,
    }),
    repositorySourceVerification: "watch_observation_only", independentSourceProof: "not_proven",
  };
}

async function readCustody(
  tx: DbTransaction,
  input: CreateDraftAcceptanceRecordFromDependencyObservationInput,
): Promise<Custody> {
  const watch = (Array.from(await tx.execute(sql`
    SELECT watch.id,
           watch.repository_id AS "repositoryId",
           repository.name AS "repositoryName",
           watch.manifest_path AS "manifestPath",
           watch.lockfile_path AS "lockfilePath"
    FROM ${dependencyWatches} AS watch
    INNER JOIN ${repositories} AS repository
      ON repository.id = watch.repository_id
    WHERE watch.workspace_id = ${input.workspaceId}
      AND watch.id = ${input.watchId}
      AND repository.workspace_id = ${input.workspaceId}
    FOR UPDATE OF watch
  `)) as Array<{
    id: string;
    repositoryId: string;
    repositoryName: string;
    manifestPath: string;
    lockfilePath: string;
  }>)[0];
  if (!watch) throw new DependencyObservationDraftError("not_found", "Dependency watch was not found in this workspace");

  // A newer failed, unchanged, or unsupported observation revokes older candidate custody.
  const observation = (await tx.select().from(dependencyWatchObservations).where(and(
    eq(dependencyWatchObservations.workspaceId, input.workspaceId),
    eq(dependencyWatchObservations.watchId, watch.id),
    eq(dependencyWatchObservations.repositoryId, watch.repositoryId),
  )).orderBy(desc(dependencyWatchObservations.observedAt), desc(dependencyWatchObservations.createdAt), desc(dependencyWatchObservations.id)).limit(1))[0];
  if (!observation) throw new DependencyObservationDraftError("not_found", "Dependency watch has no current observation");
  if (!safeText(observation.observationKey, 512)) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency observation key is not bounded custody");
  }

  const matchingCandidates = (Array.isArray(observation.candidates) ? observation.candidates : []).filter(
    (value): value is Record<string, unknown> => candidateWithFingerprint(value, input.candidateFingerprint),
  );
  if (matchingCandidates.length === 0) {
    throw new DependencyObservationDraftError("not_found", "Dependency candidate is not present in the current observation");
  }
  if (matchingCandidates.length !== 1) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency observation has ambiguous candidate custody");
  }
  const raw = matchingCandidates[0]!;
  const definition = profileDefinition(raw);
  if (!definition) {
    throw new DependencyObservationDraftError("unsupported_manager", "Dependency manager is not supported by the proposal custody profile");
  }
  const resolved = resolveDependencyObservationProposalCandidate(raw);
  const hashes = selectedHashes(observation.selectedFileHashes, definition);
  const sourceInventoryReceiptSha256 = observation.sourceInventoryReceiptSha256 ?? null;
  const sourceInventoryReceipt = sourceInventoryReceiptSha256 === null
    ? null
    : validateGoDependencySourceInventoryReceipt(
      observation.sourceInventoryReceipt,
      sourceInventoryReceiptSha256,
    );
  const exactRootPaths = watch.manifestPath === definition.manifestPath
    && watch.lockfilePath === definition.lockfilePath;
  const autoRootPaths = watch.manifestPath === "auto" && watch.lockfilePath === "auto";
  if (!exactRootPaths && !autoRootPaths) {
    throw new DependencyObservationDraftError(
      "unsafe_custody",
      `Dependency watch paths do not match the root ${definition.profile.manager} proposal custody profile`,
    );
  }
  if (observation.status !== "candidates" || !resolved
    || observation.baselineSha !== resolved.candidate.baseline_sha || !GIT_SHA.test(observation.baselineSha ?? "")
    || !hashes
    || (definition.profile.manager === "go-modules"
      ? !sourceInventoryReceipt
        || sourceInventoryReceipt.authority.repository !== watch.repositoryName
        || sourceInventoryReceipt.authority.commitSha !== observation.baselineSha
        || sourceInventoryReceipt.authority.requestedRef !== observation.baselineSha
        || sourceInventoryReceipt.requiredFiles[0]?.contentSha256
          !== (hashes as { "go.mod": string })["go.mod"]
        || sourceInventoryReceipt.requiredFiles[1]?.contentSha256
          !== (hashes as { "go.sum": string })["go.sum"]
      : sourceInventoryReceiptSha256 !== null || observation.sourceInventoryReceipt != null)) {
    throw new DependencyObservationDraftError(
      "unsafe_custody",
      `Dependency observation lacks bounded ${definition.profile.manager} proposal custody`,
    );
  }
  return {
    watchId: watch.id,
    repositoryId: watch.repositoryId,
    repositoryName: watch.repositoryName,
    observationId: observation.id,
    observationKey: observation.observationKey,
    baselineSha: observation.baselineSha,
    manifestPath: resolved.manifestPath,
    lockfilePath: resolved.lockfilePath,
    selectedFileHashes: hashes,
    candidate: resolved.candidate,
    profile: resolved.profile,
    sourceInventoryReceiptSha256,
  };
}

/** Atomically create/replay one draft-only Record, v1 Contract, and immutable provenance event. */
export async function createDraftAcceptanceRecordFromDependencyObservation(
  input: CreateDraftAcceptanceRecordFromDependencyObservationInput,
): Promise<DependencyObservationAcceptanceRecordDraft> {
  if (!exactLocator(input)) {
    throw new DependencyObservationDraftError("unsafe_custody", "Dependency proposal locator must contain exactly workspaceId, watchId, and candidateFingerprint");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`dependency-proposal:${input.workspaceId}:${input.watchId}:${input.candidateFingerprint}`}))`);
    const custody = await readCustody(tx, input);
    const proposalCustodyIdentity = custodyIdentity(custody);
    const workKey = `dependency-observation-proposal:${proposalCustodyIdentity}`;
    const recordId = changeRecordId({ workspaceId: input.workspaceId, repo: custody.repositoryName, workKey });
    const contractId = acceptanceContractId({ recordId, version: 1 });
    const eventKey = `dependency-observation-proposal:draft:${proposalCustodyIdentity}`;
    const sources = sourceReferences(custody, proposalCustodyIdentity);
    const draftContract = contract(custody, proposalCustodyIdentity);
    const provenance = payload(custody, recordId, contractId, proposalCustodyIdentity);
    const observation = { id: custody.observationId, key: custody.observationKey };
    const existing = (await tx.select().from(changeRecords).where(and(
      eq(changeRecords.workspaceId, input.workspaceId), eq(changeRecords.id, recordId),
    )).limit(1))[0];

    if (existing) {
      const storedContracts = await tx.select().from(acceptanceContracts).where(
        eq(acceptanceContracts.recordId, recordId),
      );
      const storedEvents = await tx.select().from(changeRecordEvents).where(
        eq(changeRecordEvents.recordId, recordId),
      );
      const storedContract = storedContracts[0];
      const event = storedEvents[0];
      if (existing.repo !== custody.repositoryName || existing.workKey !== workKey
        || existing.originChannel !== "dependency_watch" || !isDeepStrictEqual(existing.sourceReferences, sources)
        || existing.issueNumber !== null || existing.prNumber !== null
        || existing.currentPrHeadSha !== null || existing.currentPrHeadCycleId !== null
        || existing.currentPrHeadAuthoritative || existing.currentPrHeadAuthorityGeneration !== 0
        || !isDeepStrictEqual(existing.headShas, []) || existing.mergedSha !== null
        || existing.state !== "open"
        || storedContracts.length !== 1 || !storedContract
        || storedContract.id !== contractId || storedContract.recordId !== recordId
        || storedContract.version !== 1 || storedContract.status !== "draft"
        || storedContract.confirmedBy !== null || storedContract.confirmedAt !== null
        || storedContract.createdBy !== ACTOR || !isDeepStrictEqual(storedContract.contract, draftContract)
        || storedEvents.length !== 1 || !event
        || event.id !== changeRecordEventId({ recordId, eventKey })
        || event.recordId !== recordId || event.eventKey !== eventKey
        || event.stage !== "dependency_observation_proposal" || event.actor !== ACTOR
        || !isDeepStrictEqual(event.payloadRef, provenance)) {
        throw new DependencyObservationDraftError("conflict", "Dependency proposal custody conflicts with its immutable record");
      }
      return { record: existing, contract: storedContract, event, observation, profile: custody.profile, created: false };
    }

    const [record] = await tx.insert(changeRecords).values({
      id: recordId, workspaceId: input.workspaceId, repo: custody.repositoryName,
      workKey, originChannel: "dependency_watch", sourceReferences: sources,
    }).returning();
    const [createdContract] = await tx.insert(acceptanceContracts).values({
      id: contractId, recordId, version: 1, status: "draft", contract: draftContract, createdBy: ACTOR,
    }).returning();
    const [event] = await tx.insert(changeRecordEvents).values({
      id: changeRecordEventId({ recordId, eventKey }), recordId, eventKey,
      stage: "dependency_observation_proposal", actor: ACTOR, payloadRef: provenance,
    }).returning();
    if (!record || !createdContract || !event) throw new Error("Dependency proposal custody insert returned no row");
    return { record, contract: createdContract, event, observation, profile: custody.profile, created: true };
  });
}
