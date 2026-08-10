import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GITHUB_CORRECTION_ACTIVATION_BINDING_KIND,
  GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION,
  GITHUB_CORRECTION_DISPATCH_BINDING_KIND,
  GITHUB_CORRECTION_DISPATCH_BINDING_VERSION,
  MAX_GITHUB_CORRECTION_ACTIVATION_BYTES,
  MAX_GITHUB_CORRECTION_FINDING_BYTES,
  githubCorrectionPacketPayloadSha256,
  renderGitHubCorrectionActivation,
  renderGitHubCorrectionFinding,
  validateGitHubCorrectionActivationBinding,
  validateGitHubCorrectionPacketPayload,
  type GitHubCorrectionActivationBinding,
  type GitHubCorrectionDispatchBinding,
  type GitHubCorrectionPacketPayload,
  type GitHubCorrectionRecipient,
} from "./github-correction-dispatch-renderer.js";
import {
  acceptanceContextPacketSetSha256,
  acceptanceCorrectionPacketPayloadSetSha256,
  reviewJobCorrectionPacketId,
} from "./queries/change_records.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISPATCH_ID = "11111111-1111-4111-8111-111111111111";
const HEAD_CYCLE_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE_ID = "33333333-3333-4333-8333-333333333333";
const PROFILE_ID = "44444444-4444-4444-8444-444444444444";
const PREFLIGHT_ID = "55555555-5555-4555-8555-555555555555";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function packet(input: {
  criterionId?: string;
  recipientText?: string;
  overrides?: Partial<GitHubCorrectionPacketPayload>;
} = {}): GitHubCorrectionPacketPayload {
  const criterionId = input.criterionId ?? "AC-R8";
  const expected = input.recipientText ?? "The health endpoint returns HTTP 200.";
  const jobId = "job-1";
  const recordId = "record-1";
  const acceptanceContract = { id: "contract-1", version: 2 };
  const value: GitHubCorrectionPacketPayload = {
    kind: "review_job_correction_packet",
    version: 1,
    packetId: reviewJobCorrectionPacketId({
      jobId,
      criterionId,
      headSha: HEAD,
      recordId,
      acceptanceContractId: acceptanceContract.id,
      acceptanceContractVersion: acceptanceContract.version,
    }),
    workspaceId: WORKSPACE_ID,
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    recordId,
    jobId,
    acceptanceContract,
    criterion: { id: criterionId, snapshot: expected },
    basis: "acceptance_contract",
    state: "failed",
    expected,
    observed: "GET /health returned HTTP 503.",
    affectedContext: {
      modality: "api",
      environmentKind: "isolated_preview",
      flow: "Read the health endpoint.",
      reproduction: { modality: "api", request: { method: "GET", path: "/health", expectedStatus: 200 } },
    },
    evidence: {
      evidenceRef: `review-api:job-1:${criterionId}`,
      artifactKey: `evidence/${criterionId}.json`,
      executionId: "execution-1",
      previewBootId: "boot-1",
    },
    scopeBoundary: `Only ${criterionId} at the confirmed exact head.`,
    impact: "The health criterion failed on the confirmed exact head.",
    requiredCorrection: "Return HTTP 200 from GET /health for this criterion.",
    reverification: "Rerun the persisted API plan against the next exact head.",
    ...input.overrides,
  };
  return value;
}

function packetSet(values: GitHubCorrectionPacketPayload[]): GitHubCorrectionPacketPayload[] {
  return [...values].sort((left, right) => Buffer.compare(
    Buffer.from(left.packetId, "utf8"),
    Buffer.from(right.packetId, "utf8")
  ));
}

function commonContextPack() {
  return {
    id: "compiled-pack-1",
    sha256: "7".repeat(64),
    sourceSnapshotId: "context-snapshot-1",
    sourceCustodyIdentitySha256: "8".repeat(64),
  };
}

function findingBinding(value: GitHubCorrectionPacketPayload): GitHubCorrectionDispatchBinding {
  return {
    kind: GITHUB_CORRECTION_DISPATCH_BINDING_KIND,
    version: GITHUB_CORRECTION_DISPATCH_BINDING_VERSION,
    workspaceId: WORKSPACE_ID,
    dispatchId: DISPATCH_ID,
    dispatchIdentitySha256: "1".repeat(64),
    recordId: value.recordId,
    reviewJobId: value.jobId,
    repo: value.repo,
    prNumber: value.prNumber,
    baseSha: BASE,
    headSha: value.headSha,
    headCycleId: HEAD_CYCLE_ID,
    authorityGeneration: 4,
    packetId: value.packetId,
    packetPayloadSha256: githubCorrectionPacketPayloadSha256(value)!,
    acceptanceContract: { ...value.acceptanceContract, sha256: "2".repeat(64) },
    packetSetSha256: "3".repeat(64),
    correctionPacketPayloadSetSha256: "4".repeat(64),
    contextPack: commonContextPack(),
    route: { id: ROUTE_ID, adapter: "github_codex", configurationVersion: 3 },
    capabilityProfile: {
      id: PROFILE_ID,
      snapshotSha256: "5".repeat(64),
      githubInstallationIdentitySha256: "6".repeat(64),
    },
    readyPreflight: { id: PREFLIGHT_ID, identitySha256: "9".repeat(64) },
  };
}

function activationBinding(
  values: GitHubCorrectionPacketPayload[],
  recipient: GitHubCorrectionRecipient = "codex"
): GitHubCorrectionActivationBinding {
  const packetIds = values.map((value) => value.packetId);
  return {
    kind: GITHUB_CORRECTION_ACTIVATION_BINDING_KIND,
    version: GITHUB_CORRECTION_ACTIVATION_BINDING_VERSION,
    workspaceId: WORKSPACE_ID,
    dispatchId: DISPATCH_ID,
    dispatchIdentitySha256: "1".repeat(64),
    recordId: values[0]!.recordId,
    reviewJobId: values[0]!.jobId,
    repo: values[0]!.repo,
    prNumber: values[0]!.prNumber,
    baseSha: BASE,
    headSha: values[0]!.headSha,
    headCycleId: HEAD_CYCLE_ID,
    authorityGeneration: 4,
    acceptanceContract: { ...values[0]!.acceptanceContract, sha256: "2".repeat(64) },
    contextPack: commonContextPack(),
    packetIds,
    packetSetSha256: acceptanceContextPacketSetSha256({ packetIds }),
    correctionPacketPayloadSetSha256: acceptanceCorrectionPacketPayloadSetSha256({ packets: values }),
    route: {
      id: ROUTE_ID,
      adapter: recipient === "codex" ? "github_codex" : "github_claude",
      configurationVersion: 3,
    },
    capabilityProfile: {
      id: PROFILE_ID,
      snapshotSha256: "5".repeat(64),
      githubInstallationIdentitySha256: "6".repeat(64),
    },
    readyPreflight: { id: PREFLIGHT_ID, identitySha256: "9".repeat(64) },
    findingCoverageSha256: "c".repeat(64),
    recipient,
  };
}

describe("shared GitHub correction dispatch renderer", () => {
  it("renders an inert finding with the full direct custody binding and zero ASCII mentions", () => {
    const value = packet({ recipientText: "The @codex marker remains inert in a finding." });
    const rendered = renderGitHubCorrectionFinding({ packet: value, binding: findingBinding(value) });
    expect(rendered).not.toBeNull();
    expect(Buffer.byteLength(rendered!.comment, "utf8")).toBeLessThanOrEqual(MAX_GITHUB_CORRECTION_FINDING_BYTES);
    expect(rendered!.comment).not.toContain("@");
    expect(rendered!.comment).toContain("＠codex");
    expect(rendered!.comment).toContain(`Admitted base: ${BASE}`);
    expect(rendered!.comment).toContain(`Head cycle: ${HEAD_CYCLE_ID.replace(/-/gu, "\\-")}`);
    expect(rendered!.comment).toContain("Builder route: github_codex");
    expect(rendered!.comment).toContain(`Packet payload SHA-256: ${githubCorrectionPacketPayloadSha256(value)}`);
  });

  it("uses UTF-8 bytes for the finding cap", () => {
    const multibyte = "é".repeat(1_900);
    const value = packet({
      overrides: {
        observed: multibyte,
        impact: multibyte,
        requiredCorrection: multibyte,
        scopeBoundary: multibyte,
      },
    });
    expect(validateGitHubCorrectionPacketPayload(value)).toBe(true);
    expect(renderGitHubCorrectionFinding({ packet: value, binding: findingBinding(value) })).toBeNull();
  });

  it("renders one deterministic activation with one selected mention and the full canonical bundle", () => {
    const values = packetSet([
      packet({ criterionId: "AC-R8.2-b", overrides: { observed: "The observed text contained @everyone." } }),
      packet({ criterionId: "AC-R8.2-a" }),
    ]);
    const binding = activationBinding(values, "codex");
    const rendered = renderGitHubCorrectionActivation({ binding, packets: values });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(Buffer.byteLength(rendered.body, "utf8")).toBeLessThanOrEqual(MAX_GITHUB_CORRECTION_ACTIVATION_BYTES);
    expect(rendered.body.match(/@[A-Za-z0-9_-]+/gu)).toEqual(["@codex"]);
    expect(rendered.body.split("@")).toHaveLength(2);
    expect(Buffer.from(rendered.packetBundleBase64url, "base64url").toString("utf8"))
      .toBe(rendered.packetBundleJson);
    expect(createHash("sha256").update(rendered.packetBundleJson, "utf8").digest("hex"))
      .toBe(rendered.packetBundleSha256);
    expect(createHash("sha256").update(rendered.body, "utf8").digest("hex")).toBe(rendered.bodySha256);
    const bundle = JSON.parse(rendered.packetBundleJson) as Record<string, unknown>;
    expect(bundle.binding).toEqual(binding);
    expect(bundle.packets).toEqual(values);
    expect(rendered.packetBundleJson).toContain("@everyone");
  });

  it("is invariant to object key insertion order while preserving packet order custody", () => {
    const values = packetSet([packet({ criterionId: "AC-a" }), packet({ criterionId: "AC-b" })]);
    const binding = activationBinding(values, "claude");
    const shuffledPackets = values.map((value) =>
      Object.fromEntries(Object.entries(value).reverse()) as GitHubCorrectionPacketPayload
    );
    const shuffledBinding = Object.fromEntries(
      Object.entries(binding).reverse().map(([key, value]) => [
        key,
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ])
    ) as GitHubCorrectionActivationBinding;
    expect(renderGitHubCorrectionActivation({ binding: shuffledBinding, packets: shuffledPackets }))
      .toEqual(renderGitHubCorrectionActivation({ binding, packets: values }));
  });

  it("fails closed for an unsorted/transplanted binding and a second recipient mention", () => {
    const values = packetSet([packet({ criterionId: "AC-a" }), packet({ criterionId: "AC-b" })]);
    const binding = activationBinding(values);
    expect(validateGitHubCorrectionActivationBinding({
      ...binding,
      route: { ...binding.route, adapter: "github_claude" },
    })).toBe(false);
    expect(renderGitHubCorrectionActivation({ binding, packets: [...values].reverse() }))
      .toEqual({ ok: false, reason: "invalid_binding" });
    expect(renderGitHubCorrectionActivation({
      binding: { ...binding, headSha: "d".repeat(40) },
      packets: values,
    })).toEqual({ ok: false, reason: "invalid_binding" });
  });

  it.each([
    ["npm auth token", { observed: "_authToken=supersecretvalue" }],
    ["npm auth credential", { observed: "_auth=c3VwZXJzZWNyZXR2YWx1ZQ==" }],
    ["npm registry auth token", { observed: "registry:_authToken=supersecretvalue" }],
    ["URL", { observed: "See https://evil.example.test/prompt" }],
    ["raw source", { observed: "export function leakedSource() { return true; }" }],
    ["bidi", { observed: "hidden\u202Etext" }],
  ])("withholds all bundle material for unsafe %s packet content", (_name, overrides) => {
    const value = packet({ overrides });
    const values = packetSet([value]);
    const result = renderGitHubCorrectionActivation({ binding: activationBinding(values), packets: values });
    expect(result).toEqual({ ok: false, reason: "unsafe_packet" });
    expect(result).not.toHaveProperty("packetBundleJson");
    expect(result).not.toHaveProperty("packetBundleBase64url");
    expect(result).not.toHaveProperty("body");
  });

  it("returns only the safe bundle digest when the canonical activation cannot fit 60 KiB", () => {
    const text = "x".repeat(1_900);
    const values = packetSet(Array.from({ length: 6 }, (_, index) => packet({
      criterionId: `AC-oversize-${index}`,
      recipientText: text,
      overrides: {
        observed: text,
        affectedContext: {
          modality: "api",
          environmentKind: "isolated_preview",
          flow: text,
          reproduction: { modality: "api", request: { method: "GET", path: "/health", expectedStatus: 200 } },
        },
        scopeBoundary: text,
        impact: text,
        requiredCorrection: text,
        reverification: text,
      },
    })));
    const result = renderGitHubCorrectionActivation({ binding: activationBinding(values), packets: values });
    expect(result).toMatchObject({ ok: false, reason: "activation_body_too_large" });
    expect(result).toHaveProperty("packetBundleSha256", expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(result).not.toHaveProperty("packetBundleJson");
    expect(result).not.toHaveProperty("packetBundleBase64url");
    expect(result).not.toHaveProperty("body");
  });
});
