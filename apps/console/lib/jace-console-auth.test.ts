import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { requireJaceConsoleSecret } from "./jace-console-auth";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function req(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/approvals", { headers });
}

beforeEach(() => {
  process.env[ENV_KEY] = SECRET;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("requireJaceConsoleSecret", () => {
  it("returns null (caller may proceed) for the correct secret", () => {
    const result = requireJaceConsoleSecret(req(SECRET));
    expect(result).toBeNull();
  });

  it("401s when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open')", () => {
    delete process.env[ENV_KEY];

    const result = requireJaceConsoleSecret(req(SECRET));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s when JACE_CONSOLE_TOKEN is set to an empty string (fail closed)", () => {
    process.env[ENV_KEY] = "";

    const result = requireJaceConsoleSecret(req(SECRET));

    expect((result as NextResponse).status).toBe(401);
  });

  it("401s when there is no Authorization header", () => {
    const result = requireJaceConsoleSecret(req());
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s when the Authorization header doesn't start with 'Bearer '", () => {
    const result = requireJaceConsoleSecret(
      new NextRequest("http://localhost/api/v1/runner/approvals", {
        headers: { Authorization: `Basic ${SECRET}` },
      })
    );
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s on an empty bearer token", () => {
    const result = requireJaceConsoleSecret(req(""));
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s on a bearer token that is whitespace only", () => {
    const result = requireJaceConsoleSecret(req("   "));
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s on a wrong token of the SAME length as the real secret", () => {
    const wrongSameLength = "x".repeat(SECRET.length);
    const result = requireJaceConsoleSecret(req(wrongSameLength));
    expect((result as NextResponse).status).toBe(401);
  });

  it("401s (not 500) on a wrong token of a DIFFERENT length — timingSafeEqual throws on mismatched-length buffers, so the length check must run first", () => {
    const result = requireJaceConsoleSecret(req("short"));
    expect((result as NextResponse).status).toBe(401);
  });

  it("401 body is byte-identical across every failure branch (no oracle)", async () => {
    const noHeader = requireJaceConsoleSecret(req()) as NextResponse;
    const malformed = requireJaceConsoleSecret(
      new NextRequest("http://localhost/x", { headers: { Authorization: "Basic zzz" } })
    ) as NextResponse;
    const wrongToken = requireJaceConsoleSecret(req("nope")) as NextResponse;

    delete process.env[ENV_KEY];
    const unset = requireJaceConsoleSecret(req(SECRET)) as NextResponse;

    const bodies = await Promise.all(
      [noHeader, malformed, wrongToken, unset].map((r) => r.json())
    );
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: "Unauthorized" });
    for (const r of [noHeader, malformed, wrongToken, unset]) {
      expect(r.status).toBe(401);
    }
  });

  it("never includes the secret value in the 401 response body", async () => {
    const result = requireJaceConsoleSecret(req("wrong-value-xyz")) as NextResponse;
    const text = await result.clone().text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("wrong-value-xyz");
  });

  it("logs the missing-secret warning at most once per process, and never logs the token value", () => {
    delete process.env[ENV_KEY];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    requireJaceConsoleSecret(req(SECRET));
    requireJaceConsoleSecret(req(SECRET));
    requireJaceConsoleSecret(req(SECRET));

    // Loud but not spammy: this test file's own first unset-secret call may
    // already have logged before this test ran (module-scoped flag), so we
    // assert AT MOST one call happened during these three requests, not
    // exactly one across the whole suite.
    expect(errorSpy.mock.calls.length).toBeLessThanOrEqual(1);
    for (const call of errorSpy.mock.calls) {
      const text = call.map((c) => String(c)).join(" ");
      expect(text).not.toContain(SECRET);
    }
    errorSpy.mockRestore();
  });
});
