import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getInvestigationBySlug: vi.fn(),
  recordVerdict: vi.fn(),
}));

import { POST } from "./route";
import { getJaceSessionByEveSessionId, getInvestigationBySlug, recordVerdict } from "@agentrail/db-postgres";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetBySlug = vi.mocked(getInvestigationBySlug);
const mockRecordVerdict = vi.mocked(recordVerdict);

const WS = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "00000000-0000-0000-0000-0000000005e5";
const EVE_SESSION_ID = "eve-session-1";
const INVESTIGATION_ID = "00000000-0000-0000-0000-0000000000a1";
const SLUG = "checkout-500s";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const EXISTING_INVESTIGATION = {
  id: INVESTIGATION_ID,
  workspaceId: WS,
  repositoryId: null,
  slug: SLUG,
  title: "Checkout returns 500",
  status: "open",
  severity: "medium",
  openedBy: "chat",
  symptomStatement: "checkout returns 500 intermittently",
  symptomSignature: "checkout 500 intermittent",
  affectedSurface: "",
  firstSeenAt: null,
  verdict: null,
  confidence: null,
  depthBudget: 8,
  jaceSessionIds: [],
  createdAt: new Date("2026-07-29T00:00:00Z"),
  updatedAt: new Date("2026-07-29T00:00:00Z"),
};

function postReq(body: unknown, token: string | undefined = SECRET): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/investigations/verdict", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue({ id: SESSION_ID, workspaceId: WS } as never);
  mockGetBySlug.mockResolvedValue({ investigation: EXISTING_INVESTIGATION, items: [] } as never);
  mockRecordVerdict.mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("POST /api/v1/runner/investigations/verdict", () => {
  const validBody = { eveSessionId: EVE_SESSION_ID, slug: SLUG, verdict: "undetermined", missingEvidence: ["a"] };

  it("401 on a wrong secret, and never touches the db", async () => {
    const res = await POST(postReq(validBody, "wrong"));
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("401 when JACE_CONSOLE_TOKEN is unset", async () => {
    delete process.env[ENV_KEY];
    const res = await POST(postReq(validBody, SECRET));
    expect(res.status).toBe(401);
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(postReq("not json"));
    expect(res.status).toBe(400);
  });

  it("400 when eveSessionId is missing", async () => {
    const { eveSessionId: _omit, ...rest } = validBody;
    const res = await POST(postReq(rest));
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when slug is missing", async () => {
    const { slug: _omit, ...rest } = validBody;
    const res = await POST(postReq(rest));
    expect(res.status).toBe(400);
  });

  it("400 when verdict is missing", async () => {
    const { verdict: _omit, ...rest } = validBody;
    const res = await POST(postReq(rest));
    expect(res.status).toBe(400);
  });

  it("400 when verdict is out of enum", async () => {
    const res = await POST(postReq({ ...validBody, verdict: "definitely_the_db" }));
    expect(res.status).toBe(400);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it("400 when confidence is out of enum", async () => {
    const res = await POST(postReq({ ...validBody, verdict: "root_caused", confidence: "vibes" }));
    expect(res.status).toBe(400);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it("400 when missingEvidence is not an array of strings", async () => {
    const res = await POST(postReq({ ...validBody, missingEvidence: "not-an-array" }));
    expect(res.status).toBe(400);
  });

  it("404 when no session exists for this eveSessionId (unknown eveSessionId)", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it("404 when the session has no resolved workspace yet", async () => {
    mockGetSession.mockResolvedValue({ workspaceId: null } as never);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it("404 when the slug does not resolve to an investigation in this workspace", async () => {
    mockGetBySlug.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockRecordVerdict).not.toHaveBeenCalled();
  });

  it("scopes the investigation lookup to the caller's own workspace", async () => {
    await POST(postReq(validBody));
    expect(mockGetBySlug).toHaveBeenCalledWith(WS, SLUG);
  });

  describe("secret scan on mechanismSummary (Fix round 1: read-back path — GET mode=get/anchor re-serves the verdict item's body into model context on every future resume)", () => {
    it("422 when mechanismSummary is credential-shaped, before any DB round trip", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          eveSessionId: EVE_SESSION_ID,
          slug: SLUG,
          verdict: "root_caused",
          confidence: "confirmed",
          mechanismSummary:
            "root cause: a leaked token ghp_abcdef0123456789ABCDEFabcdef01234567 was hardcoded in the deploy script",
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/credential-shaped/i);
      expect(body.reason).toContain("github_token");
      expect(mockGetBySlug).not.toHaveBeenCalled();
      expect(mockRecordVerdict).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("does not leak the matched secret value in the 422 response", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          mechanismSummary: "token ghp_abcdef0123456789ABCDEFabcdef01234567 leaked in a log line",
        })
      );
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain("ghp_abcdef0123456789ABCDEFabcdef01234567");
    });

    it("a clean mechanismSummary still reaches recordVerdict", async () => {
      const res = await POST(
        postReq({
          eveSessionId: EVE_SESSION_ID,
          slug: SLUG,
          verdict: "root_caused",
          confidence: "confirmed",
          mechanismSummary: "connection pool starved under load",
        })
      );
      expect(res.status).toBe(200);
      expect(mockRecordVerdict).toHaveBeenCalledWith(
        INVESTIGATION_ID,
        expect.objectContaining({ mechanismSummary: "connection pool starved under load" })
      );
    });

    it("missingEvidence is NOT scanned — it lands in the data column, not the item body", async () => {
      const res = await POST(
        postReq({
          eveSessionId: EVE_SESSION_ID,
          slug: SLUG,
          verdict: "undetermined",
          missingEvidence: ["metrics containing token ghp_abcdef0123456789ABCDEFabcdef01234567 for checkout"],
        })
      );
      expect(res.status).toBe(200);
      expect(mockRecordVerdict).toHaveBeenCalled();
    });

    it("an absent mechanismSummary never triggers the scan", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      expect(mockRecordVerdict).toHaveBeenCalledWith(
        INVESTIGATION_ID,
        expect.objectContaining({ mechanismSummary: undefined })
      );
    });
  });

  describe("fail-closed gate (recordVerdict is the sole source of truth)", () => {
    it("409 with { ok: false, blocking } on an empty/ineligible investigation", async () => {
      mockRecordVerdict.mockResolvedValue({
        ok: false,
        blocking: [
          "no supported hypothesis with mechanism and evidence",
          "no refuted rival hypothesis and no solePlausible finding",
        ],
      } as never);
      const res = await POST(postReq({ ...validBody, verdict: "root_caused", confidence: "probable" }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        blocking: [
          "no supported hypothesis with mechanism and evidence",
          "no refuted rival hypothesis and no solePlausible finding",
        ],
      });
    });

    it("200 with { ok: true } once the eligibility fixture (supported + refuted rival) is seeded", async () => {
      mockRecordVerdict.mockResolvedValue({ ok: true } as never);
      const res = await POST(
        postReq({
          eveSessionId: EVE_SESSION_ID,
          slug: SLUG,
          verdict: "root_caused",
          confidence: "confirmed",
          mechanismSummary: "connection pool starved under load",
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(mockRecordVerdict).toHaveBeenCalledWith(INVESTIGATION_ID, {
        verdict: "root_caused",
        confidence: "confirmed",
        mechanismSummary: "connection pool starved under load",
        missingEvidence: undefined,
      });
    });

    it("undetermined 200s with a non-empty missingEvidence", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("relays whatever blocking reasons recordVerdict returns verbatim, including 'investigation not found' races", async () => {
      mockRecordVerdict.mockResolvedValue({ ok: false, blocking: ["investigation not found"] } as never);
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.blocking).toEqual(["investigation not found"]);
    });
  });

  it("502 when getInvestigationBySlug throws", async () => {
    mockGetBySlug.mockRejectedValue(new Error("pg down"));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(502);
  });

  it("502 when recordVerdict throws", async () => {
    mockRecordVerdict.mockRejectedValue(new Error("pg down"));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(502);
  });
});
