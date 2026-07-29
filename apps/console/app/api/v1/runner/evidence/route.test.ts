import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getSessionInvestigationAnchor: vi.fn(),
  getInvestigationById: vi.fn(),
  getConnectors: vi.fn(),
  getConnectorSecret: vi.fn(),
  appendEvidenceItem: vi.fn(),
}));

// The route imports CONNECTOR_CATALOG straight off connector-helpers.ts (same
// as production). This mock keeps every REAL catalog entry (none of which
// declare an `evidence` capability yet — Task 7 adds the first one) and adds
// ONE test-only fake provider, `fakeobs`, that declares `changes`. This is
// the "fake in tests" the brief's own interfaces section calls for — it
// proves the route works against the SAME catalog shape a real provider
// (Task 5-7) will add, with zero route changes.
vi.mock(
  "../../../../(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../../../(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers")
    >();
    return {
      ...actual,
      CONNECTOR_CATALOG: [
        ...actual.CONNECTOR_CATALOG,
        {
          kind: "fakeobs",
          type: "mcp",
          connectMethod: "secret",
          label: "Fake Observability",
          description: "test-only fake evidence provider",
          availability: "available",
          capabilities: { ingest: false, postResult: false, notify: false, evidence: ["changes"] },
        },
      ],
    };
  }
);

import { GET } from "./route";
import {
  getJaceSessionByEveSessionId,
  getSessionInvestigationAnchor,
  getInvestigationById,
  getConnectors,
  getConnectorSecret,
  appendEvidenceItem,
} from "@agentrail/db-postgres";
import { registerAdapter } from "../../../../../lib/evidence/registry";
import { EVIDENCE_MAX_BYTES } from "../../../../../lib/evidence";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetAnchor = vi.mocked(getSessionInvestigationAnchor);
const mockGetById = vi.mocked(getInvestigationById);
const mockGetConnectors = vi.mocked(getConnectors);
const mockGetSecret = vi.mocked(getConnectorSecret);
const mockAppendEvidenceItem = vi.mocked(appendEvidenceItem);

const fakeQuery = vi.fn();
registerAdapter({ provider: "fakeobs", verbs: ["changes"], query: fakeQuery });

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";
const SESSION_ID = "00000000-0000-0000-0000-0000000005e5";
const EVE_SESSION_ID = "eve-session-1";
const INVESTIGATION_ID = "00000000-0000-0000-0000-0000000000a1";

const EXISTING_INVESTIGATION = {
  id: INVESTIGATION_ID,
  workspaceId: WS,
  repositoryId: null,
  slug: "checkout-500s",
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

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const WINDOW_START = "2026-07-29T00:00:00Z";
const WINDOW_END = "2026-07-29T01:00:00Z";

function getReq(
  opts: {
    eveSessionId?: string;
    mode?: string;
    verb?: string;
    windowStart?: string;
    windowEnd?: string;
    scope?: string;
    query?: string;
    limit?: string;
    token?: string;
  } = {}
): NextRequest {
  const { eveSessionId, mode, verb, windowStart, windowEnd, scope, query, limit, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  if (mode !== undefined) params.set("mode", mode);
  if (verb !== undefined) params.set("verb", verb);
  if (windowStart !== undefined) params.set("windowStart", windowStart);
  if (windowEnd !== undefined) params.set("windowEnd", windowEnd);
  if (scope !== undefined) params.set("scope", scope);
  if (query !== undefined) params.set("query", query);
  if (limit !== undefined) params.set("limit", limit);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/runner/evidence${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers,
  });
}

function verbReq(overrides: Partial<Parameters<typeof getReq>[0]> = {}) {
  return getReq({
    token: SECRET,
    eveSessionId: EVE_SESSION_ID,
    verb: "changes",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue({
    id: SESSION_ID,
    workspaceId: WS,
  } as never);
  mockGetAnchor.mockResolvedValue(INVESTIGATION_ID);
  mockGetById.mockResolvedValue({ investigation: EXISTING_INVESTIGATION, items: [] } as never);
  mockGetConnectors.mockResolvedValue([
    { provider: "fakeobs", enabled: true, hasSecret: true, config: {}, updatedAt: null },
  ] as never);
  mockGetSecret.mockResolvedValue("fake-secret-token");
  mockAppendEvidenceItem.mockResolvedValue({ id: "evidence-item-1" } as never);
  fakeQuery.mockResolvedValue({ ok: true, raw: "run_id=abc123 merged_pr #4 at 2026-07-29T00:30:00Z" });
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/evidence", () => {
  describe("auth + tenant resolution (same posture as runner/investigations)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the db", async () => {
      delete process.env[ENV_KEY];
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await GET(getReq({ token: "nope", eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(401);
    });

    it("400 when eveSessionId is missing", async () => {
      const res = await GET(getReq({ token: SECRET, mode: "capabilities" }));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("404 when no session exists for this eveSessionId", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(404);
    });

    it("404 when the session has no resolved workspace yet", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: null } as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(404);
    });
  });

  describe("mode=capabilities", () => {
    it("200 with the family-nested capability map, needing no anchored investigation", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.evidence.changes).toContain("fakeobs");
      expect(body.evidence.search_events).toEqual([]);
      expect(body.evidence.signals).toEqual([]);
      expect(body.evidence.traces).toEqual([]);
      expect(body.evidence.probe).toEqual([]);
      // capabilities mode needs no anchor at all.
      expect(mockGetAnchor).not.toHaveBeenCalled();
      expect(mockGetById).not.toHaveBeenCalled();
    });

    it("derives capabilities from getConnectors(workspaceId)", async () => {
      await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(mockGetConnectors).toHaveBeenCalledWith(WS);
    });

    it("502 when getConnectors throws", async () => {
      mockGetConnectors.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "capabilities" }));
      expect(res.status).toBe(502);
    });
  });

  describe("verb query — validation (bad_request)", () => {
    it("degrades bad_request when verb is missing", async () => {
      const res = await GET(verbReq({ verb: undefined }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
    });

    it("degrades bad_request when verb is not one of the five", async () => {
      const res = await GET(verbReq({ verb: "bogus" }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
    });

    it("degrades bad_request when windowStart is missing", async () => {
      const res = await GET(verbReq({ windowStart: undefined }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
      expect(mockGetAnchor).not.toHaveBeenCalled();
    });

    it("degrades bad_request when windowEnd is missing", async () => {
      const res = await GET(verbReq({ windowEnd: undefined }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
    });

    it("degrades bad_request when windowStart is not a valid date", async () => {
      const res = await GET(verbReq({ windowStart: "not-a-date" }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
    });

    it("degrades bad_request when windowEnd is not a valid date", async () => {
      const res = await GET(verbReq({ windowEnd: "not-a-date" }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "bad_request" });
    });
  });

  describe("verb query — no_investigation (evidence may not be captured off-artifact)", () => {
    it("degrades no_investigation when the session has no anchored investigation", async () => {
      mockGetAnchor.mockResolvedValue(null);
      const res = await GET(verbReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "no_investigation" });
      expect(mockGetConnectors).not.toHaveBeenCalled();
      expect(fakeQuery).not.toHaveBeenCalled();
    });

    it("degrades no_investigation when the anchored investigation no longer resolves", async () => {
      mockGetById.mockResolvedValue(null);
      const res = await GET(verbReq());
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "no_investigation" });
    });

    it("tenant mismatch: degrades no_investigation when the anchored investigation belongs to ANOTHER workspace (getInvestigationById is not workspace-scoped)", async () => {
      mockGetById.mockResolvedValue({
        investigation: { ...EXISTING_INVESTIGATION, workspaceId: OTHER_WS },
        items: [],
      } as never);
      const res = await GET(verbReq());
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "no_investigation" });
      expect(fakeQuery).not.toHaveBeenCalled();
    });

    it("502 when getSessionInvestigationAnchor throws", async () => {
      mockGetAnchor.mockRejectedValue(new Error("pg down"));
      const res = await GET(verbReq());
      expect(res.status).toBe(502);
    });

    it("502 when getInvestigationById throws", async () => {
      mockGetById.mockRejectedValue(new Error("pg down"));
      const res = await GET(verbReq());
      expect(res.status).toBe(502);
    });
  });

  describe("verb query — no_provider", () => {
    it("degrades no_provider when nothing declares the requested verb", async () => {
      const res = await GET(verbReq({ verb: "probe" }));
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "no_provider" });
      expect(fakeQuery).not.toHaveBeenCalled();
    });
  });

  describe("verb query — happy path (persistence, ref echo, data.query echo)", () => {
    it("200 with one envelope per credentialed provider; ref === the persisted item id", async () => {
      const res = await GET(verbReq({ scope: "my-repo", query: "500", limit: "10" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.envelopes).toHaveLength(1);
      expect(body.envelopes[0].ref).toBe("evidence-item-1");
      expect(body.envelopes[0].provider).toBe("fakeobs");
      expect(body.envelopes[0].verb).toBe("changes");
    });

    it("queries the adapter with workspaceId, the constructed EvidenceQuery, and the resolved secret", async () => {
      await GET(verbReq({ scope: "my-repo", query: "500", limit: "10" }));
      expect(mockGetSecret).toHaveBeenCalledWith(WS, "fakeobs");
      expect(fakeQuery).toHaveBeenCalledWith(
        WS,
        {
          verb: "changes",
          windowStart: WINDOW_START,
          windowEnd: WINDOW_END,
          scope: "my-repo",
          query: "500",
          limit: 10,
        },
        "fake-secret-token"
      );
    });

    it("persists a kind:'evidence' item against the anchored investigation, with data.query echoing the request", async () => {
      await GET(verbReq());
      expect(mockAppendEvidenceItem).toHaveBeenCalledTimes(1);
      const [investigationId, input] = mockAppendEvidenceItem.mock.calls[0];
      expect(investigationId).toBe(INVESTIGATION_ID);
      expect(input.data).toMatchObject({
        provider: "fakeobs",
        verb: "changes",
        query: {
          verb: "changes",
          windowStart: WINDOW_START,
          windowEnd: WINDOW_END,
        },
      });
    });
  });

  describe("verb query — secret redaction (stored item AND envelope)", () => {
    it("redacts a credential-shaped span from both the persisted body and the returned excerpt", async () => {
      fakeQuery.mockResolvedValue({
        ok: true,
        raw: "authenticating with AKIAIOSFODNN7EXAMPLE failed",
      });
      const res = await GET(verbReq());
      const body = await res.json();

      const [, storedInput] = mockAppendEvidenceItem.mock.calls[0];
      expect(storedInput.body).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(storedInput.body).toContain("[REDACTED_SECRET]");

      expect(body.envelopes[0].excerpt).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(body.envelopes[0].excerpt).toContain("[REDACTED_SECRET]");
    });
  });

  describe("verb query — 20KB truncation", () => {
    it("caps a 20KB raw payload to <= 16KB and reports truncated: true", async () => {
      fakeQuery.mockResolvedValue({ ok: true, raw: "x".repeat(20 * 1024) });
      const res = await GET(verbReq());
      const body = await res.json();
      const envelope = body.envelopes[0];
      expect(envelope.truncated).toBe(true);
      expect(Buffer.byteLength(envelope.excerpt, "utf-8")).toBeLessThanOrEqual(EVIDENCE_MAX_BYTES);
    });

    it("a small payload is not marked truncated", async () => {
      fakeQuery.mockResolvedValue({ ok: true, raw: "short and sweet" });
      const res = await GET(verbReq());
      const body = await res.json();
      expect(body.envelopes[0].truncated).toBe(false);
    });
  });

  describe("verb query — adapter degradation relay", () => {
    it("relays the adapter's own degraded reason when the only provider fails", async () => {
      fakeQuery.mockResolvedValue({ ok: false, reason: "upstream_error" });
      const res = await GET(verbReq());
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "upstream_error" });
      expect(mockAppendEvidenceItem).not.toHaveBeenCalled();
    });

    it("does not persist anything when the adapter degrades", async () => {
      fakeQuery.mockResolvedValue({ ok: false, reason: "unauthorized" });
      await GET(verbReq());
      expect(mockAppendEvidenceItem).not.toHaveBeenCalled();
    });

    it("an adapter that THROWS instead of degrading is treated as unreachable, not a 502 (never trust an adapter's contract blindly)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      fakeQuery.mockRejectedValue(new Error("ECONNRESET"));
      const res = await GET(verbReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ degraded: true, reason: "unreachable" });
      expect(mockAppendEvidenceItem).not.toHaveBeenCalled();
    });
  });
});
