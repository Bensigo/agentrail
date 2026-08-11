import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type GitHubCorrectionPacketPayload,
} from "./github-correction-dispatch-renderer.js";
import {
  ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_BODY_BYTES,
  renderAcceptanceGatedGithubIssue,
  type AcceptanceGatedGithubIssueRenderBinding,
} from "./acceptance-gated-github-issue-renderer.js";
import {
  acceptanceContextPackCanonicalSha256,
  reviewJobCorrectionPacketId,
} from "./queries/change_records.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HEAD = "1".repeat(40);

function packet(overrides: Partial<GitHubCorrectionPacketPayload> = {}): GitHubCorrectionPacketPayload {
  const criterionId = overrides.criterion?.id ?? "AC-1";
  const criterion = overrides.criterion ?? { id: criterionId, snapshot: "A user can save a filter" };
  return {
    kind: "review_job_correction_packet",
    version: 1,
    packetId: reviewJobCorrectionPacketId({
      jobId: JOB_ID,
      criterionId,
      headSha: HEAD,
      recordId: RECORD_ID,
      acceptanceContractId: CONTRACT_ID,
      acceptanceContractVersion: 1,
    }),
    workspaceId: WORKSPACE_ID,
    repo: "acme/widgets",
    prNumber: 42,
    headSha: HEAD,
    recordId: RECORD_ID,
    jobId: JOB_ID,
    acceptanceContract: { id: CONTRACT_ID, version: 1 },
    criterion,
    basis: "acceptance_contract",
    state: "failed",
    expected: criterion.snapshot,
    observed: "The saved filter was absent after refresh.",
    affectedContext: {
      modality: "ui",
      environmentKind: "isolated_preview",
      flow: "Open the saved filters page.",
      reproduction: {
        modality: "ui",
        steps: [
          { action: "open", path: "/filters" },
          { action: "expect_text", text: "Saved filters" },
        ],
      },
    },
    evidence: {
      evidenceRef: "https://github.com/acme/widgets/actions/runs/123",
      artifactKey: "private/object/key",
      executionId: "execution-private",
      previewBootId: "preview-private",
    },
    scopeBoundary: "Only the saved-filter criterion.",
    impact: "The user cannot reuse the filter.",
    requiredCorrection: "Persist the saved filter and retain it after refresh.",
    reverification: "Repeat the exact saved-filter flow on the next exact head.",
    ...overrides,
  };
}

function binding(...values: GitHubCorrectionPacketPayload[]): AcceptanceGatedGithubIssueRenderBinding {
  const value = values[0]!;
  return {
    workspaceId: WORKSPACE_ID,
    recordId: RECORD_ID,
    repo: value.repo,
    prNumber: value.prNumber,
    headSha: HEAD,
    headCycleId: JOB_ID,
    reviewJobId: JOB_ID,
    authorityGeneration: 1,
    acceptanceContract: { id: CONTRACT_ID, version: 1, sha256: "2".repeat(64) },
    criterionOutcomeBundle: {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sha256: "3".repeat(64),
      postedAttestationEventId: "99999999-9999-4999-8999-999999999999",
    },
    packets: values.map((packetValue) => ({
      packetId: packetValue.packetId,
      sha256: acceptanceContextPackCanonicalSha256(packetValue),
    })),
    packetSetSha256: "4".repeat(64),
    correctionPacketPayloadSetSha256: "5".repeat(64),
  };
}

describe("Acceptance gated GitHub issue renderer", () => {
  it("renders one useful inert request with no labels or private artifact coordinates", () => {
    const value = packet({
      criterion: { id: "AC-1", snapshot: "Save @team's **filter** <now>" },
      observed: "The [saved filter](https://example.test) was absent.",
    });
    const rendered = renderAcceptanceGatedGithubIssue({ binding: binding(value), packets: [value] });
    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) throw new Error("expected rendering");
    expect(rendered.body).toContain("Required correction");
    expect(rendered.body).toContain("Evidence reference");
    expect(rendered.body).toContain(
      createHash("sha256").update(value.evidence.evidenceRef).digest("hex"),
    );
    expect(rendered.body).not.toContain(value.evidence.evidenceRef);
    expect(rendered.body).toContain("＠team");
    expect(rendered.body).not.toContain("@team");
    expect(rendered.body).not.toContain("<now>");
    expect(rendered.body).not.toContain("private/object/key");
    expect(rendered.body).not.toContain("execution-private");
    expect(rendered.body).not.toContain("preview-private");
    expect(rendered.body).not.toContain("labels");
    expect(Buffer.byteLength(rendered.body, "utf8")).toBeLessThanOrEqual(
      ACCEPTANCE_GATED_GITHUB_ISSUE_MAX_BODY_BYTES,
    );
  });

  it("rejects secret-like selected text and malformed repository bounds", () => {
    for (const overrides of [
      { criterion: { id: "AC-1", snapshot: `token=${"x".repeat(32)}` } },
      { observed: `ghp_${"A".repeat(32)}` },
      { evidence: { ...packet().evidence, evidenceRef: `Bearer ${"a".repeat(24)}` } },
    ] satisfies Array<Partial<GitHubCorrectionPacketPayload>>) {
      const value = packet(overrides);
      expect(renderAcceptanceGatedGithubIssue({ binding: binding(value), packets: [value] }))
        .toEqual({ ok: false, reason: "invalid_gated_issue_rendering" });
    }
    const value = packet({ repo: `${"a".repeat(101)}/widgets` });
    expect(renderAcceptanceGatedGithubIssue({ binding: binding(value), packets: [value] }))
      .toEqual({ ok: false, reason: "invalid_gated_issue_rendering" });

    const secretRepo = packet({ repo: `github_pat_${"A".repeat(24)}/widgets` });
    expect(renderAcceptanceGatedGithubIssue({ binding: binding(secretRepo), packets: [secretRepo] }))
      .toEqual({ ok: false, reason: "invalid_gated_issue_rendering" });
  });

  it("fails closed when the complete useful rendering exceeds 24 KiB", () => {
    const values = [1, 2, 3].map((index) => packet({
      criterion: { id: `AC-${index}`, snapshot: "e".repeat(2_000) },
      observed: "o".repeat(2_000),
      requiredCorrection: "r".repeat(2_000),
      reverification: "v".repeat(2_000),
      evidence: { ...packet().evidence, evidenceRef: "x".repeat(2_000) },
    })).sort((left, right) => Buffer.compare(Buffer.from(left.packetId), Buffer.from(right.packetId)));
    expect(renderAcceptanceGatedGithubIssue({ binding: binding(...values), packets: values }))
      .toEqual({ ok: false, reason: "gated_issue_body_too_large" });
  });
});
