import { createHash } from "crypto";
import { criterionVisibleTextContainsSecret } from "./queries/criterion-visible-secret-scan.js";

const MAX_BODY_BYTES = 12_288;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type AcceptanceDependencyBuilderRenderBinding = {
  deliveryId: string;
  deliveryIdentitySha256: string;
  recordId: string;
  repo: string;
  prNumber: number;
  deliveredHeadSha: string;
  deliveredHeadCycleId: string;
  authorityGeneration: number;
  acceptanceContractId: string;
  acceptanceContractVersion: number;
  acceptanceContractSha256: string;
  compiledPackId: string;
  compiledPackSha256: string;
  sourceCustodyIdentitySha256: string;
  externalBuilderPackId: string;
  externalBuilderPackEventId: string;
  externalBuilderPackIdentitySha256: string;
  candidateFingerprint: string;
  routeId: string;
  routeConfigurationVersion: number;
  capabilitySnapshotSha256: string;
  candidate: {
    package: string;
    dependencyKind: string;
    specifier: string;
    currentVersion: string;
    targetVersion: string;
  };
  packageManager: {
    name: string;
    version: string | null;
    updateArgv: string[];
  };
  manifest: { path: string; blobSha: string };
  lockfile: { path: string; blobSha: string | null };
};

export type AcceptanceDependencyBuilderRendering =
  | { ok: true; body: string; bodySha256: string; renderedByteCount: number }
  | { ok: false; reason: "invalid_binding" | "body_too_large" };

function safeText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function display(value: string): string {
  // A dependency such as @scope/pkg is legitimate metadata. Full-width @
  // prevents it becoming a second GitHub mention or notification target.
  return value.replaceAll("@", "＠").replaceAll("`", "\u02cb");
}

function valid(input: AcceptanceDependencyBuilderRenderBinding): boolean {
  const uuids = [input.deliveryId, input.recordId, input.deliveredHeadCycleId,
    input.acceptanceContractId, input.compiledPackId, input.externalBuilderPackId,
    input.externalBuilderPackEventId, input.routeId];
  const hashes = [input.deliveryIdentitySha256, input.acceptanceContractSha256,
    input.compiledPackSha256, input.sourceCustodyIdentitySha256,
    input.externalBuilderPackIdentitySha256, input.capabilitySnapshotSha256];
  const texts = [input.candidate.package, input.candidate.dependencyKind,
    input.candidate.specifier, input.candidate.currentVersion,
    input.candidate.targetVersion, input.packageManager.name,
    input.manifest.path, input.lockfile.path, ...input.packageManager.updateArgv];
  const externallyVisibleTexts = [input.repo, ...texts,
    ...(input.packageManager.version === null ? [] : [input.packageManager.version])];
  return uuids.every((value) => UUID.test(value))
    && hashes.every((value) => SHA256.test(value))
    && /^sha256:[a-f0-9]{64}$/.test(input.candidateFingerprint)
    && SHA1.test(input.deliveredHeadSha)
    && SAFE_REPO.test(input.repo)
    && Number.isSafeInteger(input.prNumber) && input.prNumber > 0
    && Number.isSafeInteger(input.authorityGeneration) && input.authorityGeneration >= 0
    && Number.isSafeInteger(input.acceptanceContractVersion) && input.acceptanceContractVersion > 0
    && Number.isSafeInteger(input.routeConfigurationVersion) && input.routeConfigurationVersion > 0
    && texts.every((value) => safeText(value, 512))
    && externallyVisibleTexts.every((value) => !criterionVisibleTextContainsSecret(value))
    && input.packageManager.updateArgv.length > 0 && input.packageManager.updateArgv.length <= 16
    && (input.packageManager.version === null || safeText(input.packageManager.version, 128))
    && SHA1.test(input.manifest.blobSha)
    && (input.lockfile.blobSha === null || SHA1.test(input.lockfile.blobSha));
}

/** Deterministic metadata-only handoff. It grants no Jace implementation authority. */
export function renderAcceptanceDependencyBuilderHandoff(
  input: AcceptanceDependencyBuilderRenderBinding,
): AcceptanceDependencyBuilderRendering {
  if (!valid(input)) return { ok: false, reason: "invalid_binding" };
  const argv = input.packageManager.updateArgv.map(display).join(" ");
  const body = [
    "@claude",
    "",
    "Jace initial dependency handoff (metadata-only, exact-head bound).",
    "",
    `- Delivery: \`${input.deliveryId}\` / \`${input.deliveryIdentitySha256}\``,
    `- Acceptance Record: \`${input.recordId}\``,
    `- Repository / PR: \`${input.repo}\` #${input.prNumber}`,
    `- Delivered head occurrence: \`${input.deliveredHeadSha}\` / \`${input.deliveredHeadCycleId}\` / authority ${input.authorityGeneration}`,
    `- Confirmed Contract: \`${input.acceptanceContractId}\` v${input.acceptanceContractVersion} / \`${input.acceptanceContractSha256}\``,
    `- Compiled Context Pack: \`${input.compiledPackId}\` / \`${input.compiledPackSha256}\` / custody \`${input.sourceCustodyIdentitySha256}\``,
    `- External Builder Pack: \`${input.externalBuilderPackId}\` / event \`${input.externalBuilderPackEventId}\` / \`${input.externalBuilderPackIdentitySha256}\``,
    `- Candidate: \`${display(input.candidate.package)}\` ${display(input.candidate.currentVersion)} -> ${display(input.candidate.targetVersion)} (${display(input.candidate.dependencyKind)}, specifier ${display(input.candidate.specifier)})`,
    `- Package manager evidence: ${display(input.packageManager.name)}${input.packageManager.version ? ` ${display(input.packageManager.version)}` : ""}; bounded argv \`${argv}\``,
    `- Manifest: \`${display(input.manifest.path)}\` / blob \`${input.manifest.blobSha}\``,
    `- Lockfile: \`${display(input.lockfile.path)}\` / blob \`${input.lockfile.blobSha ?? "not-present"}\``,
    `- Candidate fingerprint: \`${input.candidateFingerprint}\``,
    `- Selected route: \`${input.routeId}\` v${input.routeConfigurationVersion}; initial-handoff capability \`${input.capabilitySnapshotSha256}\``,
    "",
    "Implement only this approved dependency change on the bound PR. Do not merge or deploy. A successor commit must re-enter Jace exact-head review; this comment and head movement are not passing proof.",
  ].join("\n");
  const renderedByteCount = Buffer.byteLength(body, "utf8");
  if (renderedByteCount > MAX_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  if ((body.match(/@/g) ?? []).length !== 1 || !body.startsWith("@claude\n")) {
    return { ok: false, reason: "invalid_binding" };
  }
  return {
    ok: true,
    body,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    renderedByteCount,
  };
}
