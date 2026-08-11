import { scanForSecrets } from "./secret-scan";

export const ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES = 64 * 1024;
export const ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS = 8_000;
export const ACCEPTANCE_DEPENDENCY_PNPM_PROFILE = "pnpm_lockfile_only_v1";
export const ACCEPTANCE_DEPENDENCY_NPM_PROFILE = "npm_package_lock_only_v1";
export const ACCEPTANCE_DEPENDENCY_YARN_PROFILE = "yarn_berry_v4_root_lockfile_only_v1";
export const ACCEPTANCE_DEPENDENCY_UV_PROFILE = "uv_project_lockfile_only_v1";
export type AcceptanceDependencyProfileIdentity = { ecosystem: string; manager: string; profile: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA1 = /^[0-9a-f]{40}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const NORMALIZED_PYPI_PACKAGE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/iu;
const NPM_ALIAS_SPECIFIER = /^npm:/iu;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u;

type RuntimeDisposition = "safe" | "unsafe" | "unavailable" | "ambiguous";
type LockfileDisposition = "present" | "missing" | "uncommitted" | "unavailable" | "ambiguous";
type SecurityDisposition = "clear" | "affected" | "unavailable" | "ambiguous";

export type AcceptanceDependencyObservationInput = {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  candidate: {
    identity: AcceptanceDependencyProfileIdentity;
    package: string;
    dependencyKind: string;
    specifier: string;
    currentVersion: string;
    targetVersion: string;
  };
  runtime: {
    identity: AcceptanceDependencyProfileIdentity;
    disposition: RuntimeDisposition;
    version: string | null;
    evidenceSha256: string;
  };
  packageManager: {
    disposition: RuntimeDisposition;
    name: string;
    version: string | null;
    profile: string;
    updateArgv: string[];
    evidenceSha256: string;
  };
  manifest: { path: string; blobSha: string };
  lockfile: {
    disposition: LockfileDisposition;
    path: string;
    blobSha: string | null;
    evidenceSha256: string;
  };
  baseline: { headSha: string };
  security: {
    identity: AcceptanceDependencyProfileIdentity;
    disposition: SecurityDisposition;
    provider: string;
    reference: string;
    reportSha256: string;
  };
};

type AcceptanceDependencyObservationProfile = {
  readonly identity: AcceptanceDependencyProfileIdentity;
  readonly frozenUnsupportedReplayOnMismatch: boolean;
  candidateIsValid(candidate: AcceptanceDependencyObservationInput["candidate"]): boolean;
  runtimeVersionIsValid(version: string): boolean;
  packageManagerVersionIsValid(version: string): boolean;
  manifestPathIsValid(path: string): boolean;
  lockfilePathIsValid(path: string): boolean;
  securityIsValid(
    security: AcceptanceDependencyObservationInput["security"],
    candidate: AcceptanceDependencyObservationInput["candidate"],
  ): boolean;
  expectedArgv(candidate: AcceptanceDependencyObservationInput["candidate"]): string[];
};

const NODE_DEPENDENCY_KINDS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
] as const;
const NPM_SAVE_FLAG_BY_DEPENDENCY_KIND: Readonly<Record<string, string>> = {
  dependencies: "--save-prod",
  devDependencies: "--save-dev",
  optionalDependencies: "--save-optional",
  peerDependencies: "--save-peer",
};
const YARN_FLAG_BY_DEPENDENCY_KIND: Readonly<Record<string, string | null>> = {
  dependencies: null,
  devDependencies: "--dev",
  optionalDependencies: "--optional",
  peerDependencies: "--peer",
};
const ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "pnpm", profile: ACCEPTANCE_DEPENDENCY_PNPM_PROFILE,
};
const ACCEPTANCE_DEPENDENCY_NPM_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "npm", profile: ACCEPTANCE_DEPENDENCY_NPM_PROFILE,
};
const ACCEPTANCE_DEPENDENCY_YARN_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "node", manager: "yarn", profile: ACCEPTANCE_DEPENDENCY_YARN_PROFILE,
};
const ACCEPTANCE_DEPENDENCY_UV_IDENTITY: AcceptanceDependencyProfileIdentity = {
  ecosystem: "python", manager: "uv", profile: ACCEPTANCE_DEPENDENCY_UV_PROFILE,
};

function nodeCandidateIsValid(candidate: AcceptanceDependencyObservationInput["candidate"]): boolean {
  return NPM_PACKAGE.test(candidate.package) && candidate.package === candidate.package.toLowerCase()
    && NODE_DEPENDENCY_KINDS.includes(candidate.dependencyKind as typeof NODE_DEPENDENCY_KINDS[number])
    && !UNSAFE_NPM_SPECIFIER.test(candidate.specifier)
    && SEMVER.test(candidate.currentVersion) && SEMVER.test(candidate.targetVersion);
}

function npmCandidateIsValid(candidate: AcceptanceDependencyObservationInput["candidate"]): boolean {
  return nodeCandidateIsValid(candidate) && !NPM_ALIAS_SPECIFIER.test(candidate.specifier);
}

function yarnCandidateIsValid(candidate: AcceptanceDependencyObservationInput["candidate"]): boolean {
  const specifier = candidate.specifier.startsWith("^") || candidate.specifier.startsWith("~")
    ? candidate.specifier.slice(1)
    : candidate.specifier;
  return nodeCandidateIsValid(candidate)
    && !NPM_ALIAS_SPECIFIER.test(candidate.specifier)
    && SEMVER.test(specifier);
}

function stableSemverParts(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger)
    ? [parts[0]!, parts[1]!, parts[2]!]
    : null;
}

function stableNodeAtLeast1812(version: string): boolean {
  const parts = stableSemverParts(version);
  return parts !== null && (parts[0] > 18 || (parts[0] === 18 && parts[1] >= 12));
}

function stableYarn4(version: string): boolean {
  return stableSemverParts(version)?.[0] === 4;
}

function compareStableSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! > right[index]!) return 1;
    if (left[index]! < right[index]!) return -1;
  }
  return 0;
}

function uvCandidateIsValid(candidate: AcceptanceDependencyObservationInput["candidate"]): boolean {
  if (candidate.dependencyKind !== "dependencies"
    || !NORMALIZED_PYPI_PACKAGE.test(candidate.package)) return false;
  const lowerBound = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
    .exec(candidate.specifier);
  const current = stableSemverParts(candidate.currentVersion);
  const target = stableSemverParts(candidate.targetVersion);
  if (!lowerBound || !current || !target) return false;
  const bound = lowerBound.slice(1).map(Number) as [number, number, number];
  return bound.every(Number.isSafeInteger)
    && compareStableSemver(current, bound) >= 0
    && compareStableSemver(target, bound) >= 0
    && compareStableSemver(target, current) > 0;
}

function stablePython3(version: string): boolean {
  return stableSemverParts(version)?.[0] === 3;
}

function stableUv012(version: string): boolean {
  const parts = stableSemverParts(version);
  return parts?.[0] === 0 && parts[1] === 12;
}

function osvNpmSecurityIsValid(
  security: AcceptanceDependencyObservationInput["security"],
  candidate: AcceptanceDependencyObservationInput["candidate"],
): boolean {
  return security.provider === "osv"
    && security.reference === `osv:npm:${candidate.package}@${candidate.targetVersion}`;
}

function osvPyPiSecurityIsValid(
  security: AcceptanceDependencyObservationInput["security"],
  candidate: AcceptanceDependencyObservationInput["candidate"],
): boolean {
  return security.provider === "osv"
    && security.reference === `osv:PyPI:${candidate.package}@${candidate.targetVersion}`;
}

const OPERATIONAL_OBSERVATION_PROFILES = new Map<string, AcceptanceDependencyObservationProfile>([
  ["node:pnpm:pnpm_lockfile_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_PNPM_IDENTITY,
    frozenUnsupportedReplayOnMismatch: false,
    candidateIsValid: nodeCandidateIsValid,
    runtimeVersionIsValid: (version) => SEMVER.test(version),
    packageManagerVersionIsValid: (version) => SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json" || path.endsWith("/package.json"),
    lockfilePathIsValid: (path) => path === "pnpm-lock.yaml" || path.endsWith("/pnpm-lock.yaml"),
    securityIsValid: osvNpmSecurityIsValid,
    expectedArgv: (candidate) => [
      "pnpm", "update", `${candidate.package}@${candidate.targetVersion}`,
      "--lockfile-only", "--ignore-scripts",
    ],
  }],
  ["node:npm:npm_package_lock_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_NPM_IDENTITY,
    frozenUnsupportedReplayOnMismatch: true,
    candidateIsValid: npmCandidateIsValid,
    runtimeVersionIsValid: (version) => SEMVER.test(version),
    packageManagerVersionIsValid: (version) => SEMVER.test(version),
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "package-lock.json",
    securityIsValid: osvNpmSecurityIsValid,
    expectedArgv: (candidate) => [
      "npm", "install", `${candidate.package}@${candidate.targetVersion}`,
      "--package-lock-only", "--ignore-scripts", "--no-audit",
      NPM_SAVE_FLAG_BY_DEPENDENCY_KIND[candidate.dependencyKind] ?? "",
    ],
  }],
  ["node:yarn:yarn_berry_v4_root_lockfile_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_YARN_IDENTITY,
    frozenUnsupportedReplayOnMismatch: true,
    candidateIsValid: yarnCandidateIsValid,
    runtimeVersionIsValid: stableNodeAtLeast1812,
    packageManagerVersionIsValid: stableYarn4,
    manifestPathIsValid: (path) => path === "package.json",
    lockfilePathIsValid: (path) => path === "yarn.lock",
    securityIsValid: osvNpmSecurityIsValid,
    expectedArgv: (candidate) => {
      const argv = [
        "yarn", "add", `${candidate.package}@${candidate.targetVersion}`,
        "--mode=update-lockfile",
      ];
      const dependencyFlag = YARN_FLAG_BY_DEPENDENCY_KIND[candidate.dependencyKind];
      return dependencyFlag ? [...argv, dependencyFlag] : argv;
    },
  }],
  ["python:uv:uv_project_lockfile_only_v1", {
    identity: ACCEPTANCE_DEPENDENCY_UV_IDENTITY,
    frozenUnsupportedReplayOnMismatch: true,
    candidateIsValid: uvCandidateIsValid,
    runtimeVersionIsValid: stablePython3,
    packageManagerVersionIsValid: stableUv012,
    manifestPathIsValid: (path) => path === "pyproject.toml",
    lockfilePathIsValid: (path) => path === "uv.lock",
    securityIsValid: osvPyPiSecurityIsValid,
    expectedArgv: (candidate) => [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package",
      `${candidate.package}==${candidate.targetVersion}`,
    ],
  }],
]);

/**
 * This local assessment only proves that the report selected the one bounded
 * observation profile. It is never an approval or an exact-head decision: the
 * database must still re-resolve the Record, Contract, Pack, baseline and blob
 * custody before deriving the canonical observation status.
 */
export type AcceptanceDependencyObservationBoundaryAssessment =
  | "candidate_for_server_verification"
  | "refused_unsupported_profile"
  | "refused_unsafe_runtime"
  | "refused_lockfile"
  | "refused_security"
  | "not_proven";

export type ParsedAcceptanceDependencyObservation = {
  input: AcceptanceDependencyObservationInput;
  boundaryAssessment: AcceptanceDependencyObservationBoundaryAssessment;
};

export type ParsedAcceptanceDependencyObservationForStorage =
  | ({ kind: "current" } & ParsedAcceptanceDependencyObservation)
  | { kind: "historical_replay_candidate"; input: AcceptanceDependencyObservationInput };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && value === value.trim()
    && !CONTROL_OR_BIDI.test(value)
    && scanForSecrets(value).clean;
}

function safeRepoPath(value: unknown): value is string {
  return safeText(value, 1_024)
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function parseIdentity(value: unknown): AcceptanceDependencyProfileIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ecosystem", "manager", "profile"])
    || !safeText(value.ecosystem, 64) || !safeText(value.manager, 64) || !safeText(value.profile, 64)
    || !SAFE_NAME.test(value.ecosystem) || !SAFE_NAME.test(value.manager) || !SAFE_NAME.test(value.profile)) return null;
  return { ecosystem: value.ecosystem, manager: value.manager, profile: value.profile };
}

function operationalProfile(identity: AcceptanceDependencyProfileIdentity): AcceptanceDependencyObservationProfile | null {
  const profile = OPERATIONAL_OBSERVATION_PROFILES.get(`${identity.ecosystem}:${identity.manager}:${identity.profile}`);
  return profile && profile.identity.ecosystem === identity.ecosystem
    && profile.identity.manager === identity.manager && profile.identity.profile === identity.profile
    ? profile : null;
}

function parseCandidate(value: unknown): AcceptanceDependencyObservationInput["candidate"] | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "identity", "package",
    "dependencyKind",
    "specifier",
    "currentVersion",
    "targetVersion",
  ])) return null;
  if (
    !safeText(value.package, 214)
    || !safeText(value.dependencyKind, 64)
    || !safeText(value.specifier, 256)
    || !safeText(value.currentVersion, 128)
    || !safeText(value.targetVersion, 128)
    || value.currentVersion === value.targetVersion
  ) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  return { ...value, identity } as AcceptanceDependencyObservationInput["candidate"];
}

function parseRuntime(value: unknown): AcceptanceDependencyObservationInput["runtime"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["identity", "disposition", "version", "evidenceSha256"])) return null;
  if (
    !["safe", "unsafe", "unavailable", "ambiguous"].includes(value.disposition as string)
    || (value.version !== null && !safeText(value.version, 64))
    || (value.disposition === "safe"
      ? value.version === null
      : (value.disposition === "unavailable" || value.disposition === "ambiguous") && value.version !== null)
    || typeof value.evidenceSha256 !== "string"
    || !SHA256.test(value.evidenceSha256)
  ) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  return {
    identity,
    disposition: value.disposition as RuntimeDisposition,
    version: value.version as string | null,
    evidenceSha256: value.evidenceSha256.toLowerCase(),
  };
}

function parsePackageManager(value: unknown): AcceptanceDependencyObservationInput["packageManager"] | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "disposition",
    "name",
    "version",
    "profile",
    "updateArgv",
    "evidenceSha256",
  ])) return null;
  if (
    !["safe", "unsafe", "unavailable", "ambiguous"].includes(value.disposition as string)
    || typeof value.name !== "string"
    || !SAFE_NAME.test(value.name)
    || (value.version !== null && !safeText(value.version, 64))
    || (value.disposition === "safe"
      ? value.version === null
      : (value.disposition === "unavailable" || value.disposition === "ambiguous") && value.version !== null)
    || !safeText(value.profile, 64)
    || !Array.isArray(value.updateArgv)
    || value.updateArgv.length < 1
    || value.updateArgv.length > 16
    || !value.updateArgv.every((token) => safeText(token, 256))
    || typeof value.evidenceSha256 !== "string"
    || !SHA256.test(value.evidenceSha256)
  ) return null;
  return {
    disposition: value.disposition as RuntimeDisposition,
    name: value.name,
    version: value.version as string | null,
    profile: value.profile,
    updateArgv: [...value.updateArgv] as string[],
    evidenceSha256: value.evidenceSha256.toLowerCase(),
  };
}

function parseManifest(value: unknown): AcceptanceDependencyObservationInput["manifest"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "blobSha"])) return null;
  if (
    !safeRepoPath(value.path)
    || typeof value.blobSha !== "string"
    || !SHA1.test(value.blobSha)
  ) return null;
  return { path: value.path, blobSha: value.blobSha.toLowerCase() };
}

function parseLockfile(value: unknown): AcceptanceDependencyObservationInput["lockfile"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["disposition", "path", "blobSha", "evidenceSha256"])) return null;
  if (
    !["present", "missing", "uncommitted", "unavailable", "ambiguous"].includes(value.disposition as string)
    || !safeRepoPath(value.path)
    || (value.blobSha !== null && (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha)))
    || (value.disposition === "present" ? value.blobSha === null : value.blobSha !== null)
    || typeof value.evidenceSha256 !== "string"
    || !SHA256.test(value.evidenceSha256)
  ) return null;
  return {
    disposition: value.disposition as LockfileDisposition,
    path: value.path,
    blobSha: value.blobSha === null ? null : value.blobSha.toLowerCase(),
    evidenceSha256: value.evidenceSha256.toLowerCase(),
  };
}

function parseBaseline(value: unknown): AcceptanceDependencyObservationInput["baseline"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["headSha"])) return null;
  if (typeof value.headSha !== "string" || !SHA1.test(value.headSha)) return null;
  return { headSha: value.headSha.toLowerCase() };
}

function parseSecurity(value: unknown): AcceptanceDependencyObservationInput["security"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["identity", "disposition", "provider", "reference", "reportSha256"])) return null;
  if (
    !["clear", "affected", "unavailable", "ambiguous"].includes(value.disposition as string)
    || !safeText(value.provider, 64) || !safeText(value.reference, 512)
    || typeof value.reportSha256 !== "string"
    || !SHA256.test(value.reportSha256)
  ) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  return {
    identity,
    disposition: value.disposition as SecurityDisposition,
    provider: value.provider,
    reference: value.reference,
    reportSha256: value.reportSha256.toLowerCase(),
  };
}

function boundaryAssessment(input: AcceptanceDependencyObservationInput): AcceptanceDependencyObservationBoundaryAssessment {
  const profile = operationalProfile(input.candidate.identity);
  if (!profile
    || input.runtime.identity.ecosystem !== input.candidate.identity.ecosystem
    || input.runtime.identity.manager !== input.candidate.identity.manager
    || input.runtime.identity.profile !== input.candidate.identity.profile
    || input.security.identity.ecosystem !== input.candidate.identity.ecosystem
    || input.security.identity.manager !== input.candidate.identity.manager
    || input.security.identity.profile !== input.candidate.identity.profile) return "refused_unsupported_profile";
  const expectedArgv = profile.expectedArgv(input.candidate);
  const exactRuntimeProfile = input.runtime.disposition !== "unsafe";
  const exactPackageManagerProfile = input.packageManager.disposition !== "unsafe"
    && input.packageManager.name === profile.identity.manager
    && input.packageManager.profile === profile.identity.profile
    && (
      input.packageManager.disposition !== "safe"
      || (
        input.packageManager.version !== null
        && input.packageManager.updateArgv.length === expectedArgv.length
        && input.packageManager.updateArgv.every(
          (token, index) => token === expectedArgv[index]
        )
      )
    );
  if (!exactRuntimeProfile || !exactPackageManagerProfile) return "refused_unsafe_runtime";
  if (input.lockfile.disposition !== "present") return "refused_lockfile";
  if (input.security.disposition !== "clear") return "refused_security";
  if (input.runtime.disposition !== "safe" || input.packageManager.disposition !== "safe") {
    return "not_proven";
  }
  return "candidate_for_server_verification";
}

export function parseAcceptanceDependencyObservationForStorage(
  value: unknown,
): ParsedAcceptanceDependencyObservationForStorage | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "workspaceId",
    "recordId",
    "compiledPackId",
    "candidate",
    "runtime",
    "packageManager",
    "manifest",
    "lockfile",
    "baseline",
    "security",
  ])) return null;
  if (
    typeof value.workspaceId !== "string" || !UUID.test(value.workspaceId)
    || typeof value.recordId !== "string" || !UUID.test(value.recordId)
    || typeof value.compiledPackId !== "string" || !UUID.test(value.compiledPackId)
  ) return null;
  const candidate = parseCandidate(value.candidate);
  const runtime = parseRuntime(value.runtime);
  const packageManager = parsePackageManager(value.packageManager);
  const manifest = parseManifest(value.manifest);
  const lockfile = parseLockfile(value.lockfile);
  const baseline = parseBaseline(value.baseline);
  const security = candidate ? parseSecurity(value.security) : null;
  if (!candidate || !runtime || !packageManager || !manifest || !lockfile || !baseline || !security) return null;
  const input: AcceptanceDependencyObservationInput = {
    workspaceId: value.workspaceId.toLowerCase(),
    recordId: value.recordId.toLowerCase(),
    compiledPackId: value.compiledPackId.toLowerCase(),
    candidate,
    runtime,
    packageManager,
    manifest,
    lockfile,
    baseline,
    security,
  };
  const profile = operationalProfile(input.candidate.identity);
  const candidateMatchesProfile = profile?.candidateIsValid(input.candidate) ?? true;
  const evidenceMatchesProfile = !profile || (
    candidateMatchesProfile
    && !(
      (input.runtime.disposition === "safe"
        && !profile.runtimeVersionIsValid(input.runtime.version ?? ""))
      || (input.packageManager.disposition === "safe"
        && !profile.packageManagerVersionIsValid(input.packageManager.version ?? ""))
      || !profile.manifestPathIsValid(input.manifest.path)
      || !profile.lockfilePathIsValid(input.lockfile.path)
      || !profile.securityIsValid(input.security, input.candidate)
    )
  );
  if (!evidenceMatchesProfile) {
    return profile?.frozenUnsupportedReplayOnMismatch
      ? { kind: "historical_replay_candidate", input }
      : null;
  }
  return {
    kind: "current",
    input,
    boundaryAssessment: boundaryAssessment(input),
  };
}

export function parseAcceptanceDependencyObservation(
  value: unknown,
): ParsedAcceptanceDependencyObservation | null {
  const parsed = parseAcceptanceDependencyObservationForStorage(value);
  return parsed?.kind === "current"
    ? { input: parsed.input, boundaryAssessment: parsed.boundaryAssessment }
    : null;
}

export type BoundedJsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid_content_type" | "invalid_length" | "body_unavailable" | "timeout" | "invalid_json" };

/** Read one fatal-UTF-8 JSON body without allowing declared or streamed overflow. */
export async function readBoundedAcceptanceDependencyObservationJson(
  request: Request
): Promise<BoundedJsonReadResult> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_content_type" };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES)) {
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_length" };
  }
  if (!request.body) return { ok: false, reason: "body_unavailable" };
  const reader = request.body.getReader();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
      reject(new Error("Dependency observation body timed out"));
    }, ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS);
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "invalid_length" };
      }
      chunks.push(next.value);
    }
    if (timedOut) return { ok: false, reason: "timeout" };
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        ok: true,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      };
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  } catch {
    return { ok: false, reason: timedOut ? "timeout" : "body_unavailable" };
  } finally {
    clearTimeout(timer!);
  }
}
