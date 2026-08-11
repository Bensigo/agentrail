import { scanForSecrets } from "./secret-scan";

export const ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES = 64 * 1024;
export const ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS = 8_000;
export const ACCEPTANCE_DEPENDENCY_PROFILE = "pnpm_lockfile_only_v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA1 = /^[0-9a-f]{40}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UNSAFE_NPM_SPECIFIER = /^(?:file|link|workspace|git\+|git|path|https?):/iu;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/u;

type RuntimeDisposition = "safe" | "unsafe" | "unavailable" | "ambiguous";
type LockfileDisposition = "present" | "missing" | "uncommitted" | "unavailable" | "ambiguous";
type SecurityDisposition = "clear" | "affected" | "unavailable" | "ambiguous";

export type AcceptanceDependencyObservationInput = {
  workspaceId: string;
  recordId: string;
  compiledPackId: string;
  candidate: {
    package: string;
    dependencyKind: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
    specifier: string;
    currentVersion: string;
    targetVersion: string;
  };
  runtime: {
    disposition: RuntimeDisposition;
    nodeVersion: string | null;
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
    disposition: SecurityDisposition;
    provider: "osv";
    reference: string;
    reportSha256: string;
  };
};

/**
 * This local assessment only proves that the report selected the one bounded
 * observation profile. It is never an approval or an exact-head decision: the
 * database must still re-resolve the Record, Contract, Pack, baseline and blob
 * custody before deriving the canonical observation status.
 */
export type AcceptanceDependencyObservationBoundaryAssessment =
  | "candidate_for_server_verification"
  | "refused_unsafe_runtime"
  | "refused_lockfile"
  | "refused_security"
  | "not_proven";

export type ParsedAcceptanceDependencyObservation = {
  input: AcceptanceDependencyObservationInput;
  boundaryAssessment: AcceptanceDependencyObservationBoundaryAssessment;
};

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

function parseCandidate(value: unknown): AcceptanceDependencyObservationInput["candidate"] | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "package",
    "dependencyKind",
    "specifier",
    "currentVersion",
    "targetVersion",
  ])) return null;
  if (
    !safeText(value.package, 214)
    || !NPM_PACKAGE.test(value.package)
    || (value.package !== value.package.toLowerCase())
    || !["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].includes(
      value.dependencyKind as string
    )
    || !safeText(value.specifier, 256)
    || UNSAFE_NPM_SPECIFIER.test(value.specifier)
    || !safeText(value.currentVersion, 128)
    || !SEMVER.test(value.currentVersion)
    || !safeText(value.targetVersion, 128)
    || !SEMVER.test(value.targetVersion)
    || value.currentVersion === value.targetVersion
  ) return null;
  return value as AcceptanceDependencyObservationInput["candidate"];
}

function parseRuntime(value: unknown): AcceptanceDependencyObservationInput["runtime"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["disposition", "nodeVersion", "evidenceSha256"])) return null;
  if (
    !["safe", "unsafe", "unavailable", "ambiguous"].includes(value.disposition as string)
    || (value.nodeVersion !== null && !safeText(value.nodeVersion, 64))
    || (value.disposition === "safe"
      ? value.nodeVersion === null || !SEMVER.test(value.nodeVersion)
      : (value.disposition === "unavailable" || value.disposition === "ambiguous") && value.nodeVersion !== null)
    || typeof value.evidenceSha256 !== "string"
    || !SHA256.test(value.evidenceSha256)
  ) return null;
  return {
    disposition: value.disposition as RuntimeDisposition,
    nodeVersion: value.nodeVersion as string | null,
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
      ? value.version === null || !SEMVER.test(value.version)
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
    || (value.path !== "package.json" && !value.path.endsWith("/package.json"))
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
    || (value.path !== "pnpm-lock.yaml" && !value.path.endsWith("/pnpm-lock.yaml"))
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

function parseSecurity(
  value: unknown,
  candidate: AcceptanceDependencyObservationInput["candidate"]
): AcceptanceDependencyObservationInput["security"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["disposition", "provider", "reference", "reportSha256"])) return null;
  if (
    !["clear", "affected", "unavailable", "ambiguous"].includes(value.disposition as string)
    || value.provider !== "osv"
    || value.reference !== `osv:npm:${candidate.package}@${candidate.targetVersion}`
    || typeof value.reportSha256 !== "string"
    || !SHA256.test(value.reportSha256)
  ) return null;
  return {
    disposition: value.disposition as SecurityDisposition,
    provider: value.provider,
    reference: value.reference,
    reportSha256: value.reportSha256.toLowerCase(),
  };
}

function boundaryAssessment(input: AcceptanceDependencyObservationInput): AcceptanceDependencyObservationBoundaryAssessment {
  const expectedArgv = [
    "pnpm",
    "update",
    `${input.candidate.package}@${input.candidate.targetVersion}`,
    "--lockfile-only",
    "--ignore-scripts",
  ];
  const exactRuntimeProfile = input.runtime.disposition !== "unsafe";
  const exactPackageManagerProfile = input.packageManager.disposition !== "unsafe"
    && (
      input.packageManager.disposition !== "safe"
      || (
      input.packageManager.name === "pnpm"
      && input.packageManager.version !== null
      && input.packageManager.profile === ACCEPTANCE_DEPENDENCY_PROFILE
      && input.packageManager.updateArgv.length === expectedArgv.length
      && input.packageManager.updateArgv.every((token, index) => token === expectedArgv[index])
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

export function parseAcceptanceDependencyObservation(value: unknown): ParsedAcceptanceDependencyObservation | null {
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
  const security = candidate ? parseSecurity(value.security, candidate) : null;
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
  return { input, boundaryAssessment: boundaryAssessment(input) };
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
