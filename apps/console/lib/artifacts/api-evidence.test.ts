import { describe, expect, it } from "vitest";
import { ApiEvidenceError, redactApiEvidence } from "./api-evidence";

describe("redactApiEvidence", () => {
  it("redacts nested credential fields, headers, URLs, and credential text", () => {
    const evidence = redactApiEvidence({
      request: {
        url: "https://user:private@api.example.test/save?token=private&ok=yes",
        headers: { Authorization: "Bearer abc", "x-api-key": "key", Accept: "application/json" },
        body: { password: "hidden", title: "Draft" },
      },
      response: { status: 200, body: { nested: { secret: "hidden" }, message: "saved" } },
      note: "Authorization: Basic dXNlcjpwYXNz",
    }) as Record<string, any>;
    expect(evidence.request.url).toContain("token=[REDACTED]");
    expect(evidence.request.url).toContain("ok=yes");
    expect(evidence.request.url).not.toContain("private");
    expect(evidence.request.url).not.toContain("user");
    expect(evidence.request.headers.Authorization).toBe("[REDACTED]");
    expect(evidence.request.headers["x-api-key"]).toBe("[REDACTED]");
    expect(evidence.request.headers.Accept).toBe("application/json");
    expect(evidence.request.body.password).toBe("[REDACTED]");
    expect(evidence.response.body.nested.secret).toBe("[REDACTED]");
    expect(evidence.note).toContain("Basic [REDACTED]");
  });

  it("preserves normal JSON values and rejects non-JSON or unbounded input", () => {
    expect(redactApiEvidence({ request: { method: "GET" }, response: { status: 204 }, assertions: ["returns no content"] }))
      .toEqual({ request: { method: "GET" }, response: { status: 204 }, assertions: ["returns no content"] });
    expect(() => redactApiEvidence({ invalid: new Date() })).toThrow(ApiEvidenceError);
    let value: unknown = "leaf";
    for (let index = 0; index < 14; index += 1) value = { value };
    expect(() => redactApiEvidence(value)).toThrow("maximum nesting depth");
  });
});
