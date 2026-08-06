import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  resolveEvidenceVerificationPlanForArtifact: vi.fn(),
  recordEvidenceVerificationArtifact: vi.fn(),
}));
vi.mock("../../../../../lib/artifacts/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../../lib/artifacts/store")>()),
  putArtifact: vi.fn(), signedGetUrl: vi.fn(),
}));

import { recordEvidenceVerificationArtifact, resolveEvidenceVerificationPlanForArtifact } from "@agentrail/db-postgres";
import { putArtifact, signedGetUrl } from "../../../../../lib/artifacts/store";
import { POST } from "./route";

const secret = "secret";
const body = {
  workspaceId: "ws", recordId: "record", prRevisionId: "revision", verificationPlanId: "plan", collectedBy: "worker", index: 1,
  evidence: {
    request: { method: "GET", url: "https://api.example.test/widgets", headers: { Authorization: "Bearer private" } },
    response: { status: 200, body: { token: "private", ok: true } },
    assertions: ["returns the current widget"],
  },
};
const request = (value: unknown = body, auth = true) => new NextRequest("http://localhost/api/v1/runner/evidence-verification-api-artifacts", {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(value),
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = secret; process.env.REVIEW_EVIDENCE_ENABLED = "1";
  process.env.S3_ENDPOINT = "http://localhost:9000"; process.env.S3_ACCESS_KEY = "key"; process.env.S3_SECRET_KEY = "secret"; process.env.S3_BUCKET = "bucket";
  vi.mocked(resolveEvidenceVerificationPlanForArtifact).mockResolvedValue({ plan: { id: "plan", criterionId: "widget-api", environmentId: "api-env", apiRequest: { method: "GET", path: "/widgets", expectedStatus: 200 } }, repositoryFullName: "ada/widgets", prNumber: 42, headSha: "abcdef0123456789", previewUrl: "https://api.example.test" } as never);
  vi.mocked(recordEvidenceVerificationArtifact).mockResolvedValue({ id: "artifact", verificationPlanId: "plan", artifactKey: "review-evidence/ws/ada__widgets/42/abcdef0123456789/widget-api.json" } as never);
  vi.mocked(signedGetUrl).mockResolvedValue("https://signed.example/artifact" as never);
});

describe("API verification artifact upload", () => {
  it("stores redacted request-response proof only for the exact planned API criterion", async () => {
    expect((await POST(request())).status).toBe(201);
    expect(resolveEvidenceVerificationPlanForArtifact).toHaveBeenCalledWith(expect.objectContaining({ verificationPlanId: "plan", modality: "api" }));
    expect(recordEvidenceVerificationArtifact).toHaveBeenCalledWith(expect.objectContaining({ verificationPlanId: "plan", contentType: "application/json", contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    const bytes = vi.mocked(putArtifact).mock.calls[0][1];
    expect(bytes.toString()).toContain("[REDACTED]");
    expect(bytes.toString()).not.toContain("private");
  });

  it("rejects incomplete evidence and a stale or non-API plan", async () => {
    expect((await POST(request({ ...body, evidence: { request: {}, response: {}, assertions: [] } }))).status).toBe(400);
    vi.mocked(resolveEvidenceVerificationPlanForArtifact).mockResolvedValue(null);
    expect((await POST(request())).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("rejects an API artifact whose origin, method, path, query, or status differs from the immutable plan", async () => {
    for (const evidence of [
      { ...body.evidence, request: { ...body.evidence.request, url: "https://untrusted.example.test/widgets" } },
      { ...body.evidence, request: { ...body.evidence.request, method: "POST" } },
      { ...body.evidence, request: { ...body.evidence.request, url: "https://api.example.test/other" } },
      { ...body.evidence, request: { ...body.evidence.request, url: "https://api.example.test/widgets?extra=1" } },
      { ...body.evidence, response: { ...body.evidence.response, status: 201 } },
    ]) expect((await POST(request({ ...body, evidence }))).status).toBe(409);
    expect(putArtifact).not.toHaveBeenCalled();
  });

  it("fails closed without the runner secret", async () => {
    expect((await POST(request(body, false))).status).toBe(401);
    expect(resolveEvidenceVerificationPlanForArtifact).not.toHaveBeenCalled();
  });
});
