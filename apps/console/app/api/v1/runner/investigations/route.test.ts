import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getInvestigationBySlug: vi.fn(),
  getInvestigationById: vi.fn(),
  listInvestigations: vi.fn(),
  searchInvestigations: vi.fn(),
  upsertInvestigation: vi.fn(),
  patchInvestigationItems: vi.fn(),
  computeVerdictEligibility: vi.fn(),
  linkInvestigations: vi.fn(),
  setSessionInvestigationAnchor: vi.fn(),
  clearSessionInvestigationAnchor: vi.fn(),
}));

import { GET, POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getInvestigationBySlug,
  getInvestigationById,
  listInvestigations,
  searchInvestigations,
  upsertInvestigation,
  patchInvestigationItems,
  computeVerdictEligibility,
  linkInvestigations,
  setSessionInvestigationAnchor,
  clearSessionInvestigationAnchor,
} from "@agentrail/db-postgres";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetBySlug = vi.mocked(getInvestigationBySlug);
const mockGetById = vi.mocked(getInvestigationById);
const mockList = vi.mocked(listInvestigations);
const mockSearch = vi.mocked(searchInvestigations);
const mockUpsert = vi.mocked(upsertInvestigation);
const mockPatchItems = vi.mocked(patchInvestigationItems);
const mockComputeEligibility = vi.mocked(computeVerdictEligibility);
const mockLinkInvestigations = vi.mocked(linkInvestigations);
const mockSetAnchor = vi.mocked(setSessionInvestigationAnchor);
const mockClearAnchor = vi.mocked(clearSessionInvestigationAnchor);

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";
const SESSION_ID = "00000000-0000-0000-0000-0000000005e5";
const EVE_SESSION_ID = "eve-session-1";
const INVESTIGATION_ID = "00000000-0000-0000-0000-0000000000a1";
const TARGET_INVESTIGATION_ID = "00000000-0000-0000-0000-0000000000a2";
const SLUG = "checkout-500s";

// Central-secret auth, same idiom as briefs/workspace-memory/repo-wiki's own tests.
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

const TARGET_INVESTIGATION = {
  ...EXISTING_INVESTIGATION,
  id: TARGET_INVESTIGATION_ID,
  slug: "checkout-500s-original",
};

const SOME_ITEM = {
  id: "item-1",
  investigationId: INVESTIGATION_ID,
  kind: "hypothesis",
  body: "connection pool exhaustion",
  mechanism: "",
  state: "open",
  evidenceRefs: [],
  data: {},
  authority: "jace",
  createdAt: new Date("2026-07-29T00:00:00Z"),
  updatedAt: new Date("2026-07-29T00:00:00Z"),
};

const ELIGIBLE = { eligible: true, blocking: [] };
const INELIGIBLE = {
  eligible: false,
  blocking: [
    "no supported hypothesis with mechanism and evidence",
    "no refuted rival hypothesis and no solePlausible finding",
  ],
};

const EMPTY_PATCH_RESULT = {
  applied: [],
  skippedHumanAuthorityIds: [],
  skippedEvidenceImmutableIds: [],
  skippedHypothesisNeedsEvidence: [],
  skippedKindChangeIds: [],
  unmatchedIds: [],
};

function getReq(
  opts: {
    eveSessionId?: string;
    mode?: string;
    slug?: string;
    query?: string;
    token?: string;
  } = {}
): NextRequest {
  const { eveSessionId, mode, slug, query, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  if (mode !== undefined) params.set("mode", mode);
  if (slug !== undefined) params.set("slug", slug);
  if (query !== undefined) params.set("query", query);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/runner/investigations${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers,
  });
}

function postReq(body: unknown, token: string | undefined = SECRET): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/investigations", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue({
    id: SESSION_ID,
    workspaceId: WS,
    anchoredInvestigationId: null,
  } as never);
  mockGetBySlug.mockImplementation(async (workspaceId: string, slug: string) => {
    if (workspaceId === WS && slug === SLUG) {
      return { investigation: EXISTING_INVESTIGATION, items: [SOME_ITEM] } as never;
    }
    if (workspaceId === WS && slug === TARGET_INVESTIGATION.slug) {
      return { investigation: TARGET_INVESTIGATION, items: [] } as never;
    }
    return null as never;
  });
  mockGetById.mockResolvedValue({ investigation: EXISTING_INVESTIGATION, items: [SOME_ITEM] } as never);
  mockList.mockResolvedValue([EXISTING_INVESTIGATION] as never);
  mockSearch.mockResolvedValue([EXISTING_INVESTIGATION] as never);
  mockUpsert.mockResolvedValue(EXISTING_INVESTIGATION as never);
  mockPatchItems.mockResolvedValue(EMPTY_PATCH_RESULT as never);
  mockComputeEligibility.mockResolvedValue(ELIGIBLE as never);
  mockLinkInvestigations.mockResolvedValue(undefined as never);
  mockSetAnchor.mockResolvedValue(true as never);
  mockClearAnchor.mockResolvedValue(true as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/investigations", () => {
  describe("auth + tenant resolution (shared with POST, same posture as briefs/workspace-memory)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset, and never touches the db", async () => {
      delete process.env[ENV_KEY];
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret", async () => {
      const res = await GET(getReq({ token: "nope", eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(401);
    });

    it("400 when eveSessionId is missing", async () => {
      const res = await GET(getReq({ token: SECRET, mode: "list" }));
      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("404 when no session exists for this eveSessionId (unknown eveSessionId)", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(404);
      expect(mockList).not.toHaveBeenCalled();
    });

    it("404 when the session has no resolved workspace yet (intro session)", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: null } as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(404);
      expect(mockList).not.toHaveBeenCalled();
    });
  });

  it("400 on an invalid mode", async () => {
    const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "bogus" }));
    expect(res.status).toBe(400);
  });

  describe("mode=list", () => {
    it("200 with every investigation for the workspace", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("list");
      expect(body.investigations).toHaveLength(1);
      expect(mockList).toHaveBeenCalledWith(WS);
    });

    it("does not compute eligibility for a list — the compact index never pulls the per-investigation items query eligibility needs", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      const body = await res.json();
      expect(body.investigations[0].eligibility).toBeUndefined();
      expect(mockComputeEligibility).not.toHaveBeenCalled();
    });

    it("502 when listInvestigations throws", async () => {
      mockList.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" }));
      expect(res.status).toBe(502);
    });
  });

  describe("mode=get", () => {
    it("400 when slug is missing", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get" }));
      expect(res.status).toBe(400);
      expect(mockGetBySlug).not.toHaveBeenCalled();
    });

    it("404 when no investigation matches the slug (Jace renders 'none yet')", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: "no-such-investigation" })
      );
      expect(res.status).toBe(404);
    });

    it("200 with the investigation and its items when found", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("get");
      expect(body.investigation).toMatchObject({ slug: SLUG });
      expect(body.items).toHaveLength(1);
      expect(mockGetBySlug).toHaveBeenCalledWith(WS, SLUG);
    });

    it("attaches eligibility verbatim from computeVerdictEligibility", async () => {
      mockComputeEligibility.mockResolvedValue(INELIGIBLE as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG }));
      const body = await res.json();
      expect(body.eligibility).toEqual(INELIGIBLE);
      expect(mockComputeEligibility).toHaveBeenCalledWith(INVESTIGATION_ID);
    });

    it("502 when getInvestigationBySlug throws", async () => {
      mockGetBySlug.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG }));
      expect(res.status).toBe(502);
    });

    it("502 when computeVerdictEligibility throws", async () => {
      mockComputeEligibility.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG }));
      expect(res.status).toBe(502);
    });
  });

  describe("mode=search", () => {
    it("400 when query is missing", async () => {
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search" }));
      expect(res.status).toBe(400);
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it("200 with matching investigations, no eligibility attached", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search", query: "checkout" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("search");
      expect(body.investigations).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalledWith(WS, "checkout");
      expect(mockComputeEligibility).not.toHaveBeenCalled();
    });

    it("502 when searchInvestigations throws", async () => {
      mockSearch.mockRejectedValue(new Error("pg down"));
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search", query: "checkout" })
      );
      expect(res.status).toBe(502);
    });
  });

  describe("mode=anchor", () => {
    it("returns { investigation: null } when the session has no investigation anchored yet", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: null,
      } as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("anchor");
      expect(body.investigation).toBeNull();
      expect(mockGetById).not.toHaveBeenCalled();
      expect(mockComputeEligibility).not.toHaveBeenCalled();
    });

    it("returns the full anchored investigation + items + eligibility — the same shape mode=get returns", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: INVESTIGATION_ID,
      } as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockGetById).toHaveBeenCalledWith(INVESTIGATION_ID);
      expect(body.investigation.slug).toBe(SLUG);
      expect(body.items).toHaveLength(1);
      expect(body.eligibility).toEqual(ELIGIBLE);
      expect(mockComputeEligibility).toHaveBeenCalledWith(INVESTIGATION_ID);
    });

    it("returns { investigation: null } (not an error) when the anchored investigation no longer resolves", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: INVESTIGATION_ID,
      } as never);
      mockGetById.mockResolvedValue(null);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.investigation).toBeNull();
      expect(mockComputeEligibility).not.toHaveBeenCalled();
    });

    it("tenant safety: returns { investigation: null } when the anchored id resolves to ANOTHER workspace's investigation (getInvestigationById is not workspace-scoped)", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: INVESTIGATION_ID,
      } as never);
      mockGetById.mockResolvedValue({
        investigation: { ...EXISTING_INVESTIGATION, workspaceId: OTHER_WS },
        items: [],
      } as never);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.investigation).toBeNull();
      expect(mockComputeEligibility).not.toHaveBeenCalled();
    });

    it("404s the same as every other mode when there's no session", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(404);
    });

    it("502 when getInvestigationById throws", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: INVESTIGATION_ID,
      } as never);
      mockGetById.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(502);
    });

    it("502 when computeVerdictEligibility throws for the anchored investigation", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredInvestigationId: INVESTIGATION_ID,
      } as never);
      mockComputeEligibility.mockRejectedValue(new Error("pg down"));
      const res = await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(res.status).toBe(502);
    });
  });
});

describe("POST /api/v1/runner/investigations", () => {
  const validBody = {
    eveSessionId: EVE_SESSION_ID,
    slug: SLUG,
    title: "Checkout returns 500",
  };

  it("401 on a wrong secret, and never touches the db", async () => {
    const res = await POST(postReq(validBody, "wrong"));
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(postReq("not json"));
    expect(res.status).toBe(400);
  });

  it("400 when eveSessionId is missing", async () => {
    const { eveSessionId: _omit, ...noEve } = validBody;
    const res = await POST(postReq(noEve));
    expect(res.status).toBe(400);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("400 when slug is missing", async () => {
    const { slug: _omit, ...noSlug } = validBody;
    const res = await POST(postReq(noSlug));
    expect(res.status).toBe(400);
  });

  it("404 when no session exists for this eveSessionId (unknown eveSessionId)", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("404 when the session has no resolved workspace yet", async () => {
    mockGetSession.mockResolvedValue({ workspaceId: null } as never);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  describe("verdict/status rejection (Global Constraints: verdicts never travel through save)", () => {
    it("400 when verdict is present in the body, with the exact refusal text, and never writes", async () => {
      const res = await POST(postReq({ ...validBody, verdict: "root_caused" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        "verdict and status never travel through save — use /investigations/verdict; status is derived"
      );
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockPatchItems).not.toHaveBeenCalled();
    });

    it("400 when status is present in the body, with the exact refusal text, and never writes", async () => {
      const res = await POST(postReq({ ...validBody, status: "concluded" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        "verdict and status never travel through save — use /investigations/verdict; status is derived"
      );
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("400 even when status is an unexpected shape (never silently dropped)", async () => {
      const res = await POST(postReq({ ...validBody, status: null }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("rejects verdict/status ahead of the general shape check, even alongside otherwise-malformed content", async () => {
      const res = await POST(postReq({ ...validBody, verdict: "root_caused", items: "not-an-array" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/verdict and status never travel through save/);
    });
  });

  describe("secret scan on write (mirrors runner/briefs, #1032)", () => {
    it("422 and does not write when symptomStatement is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          symptomStatement: "prod aws key is AKIAIOSFODNN7EXAMPLE, do not lose it",
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/credential-shaped/i);
      expect(body.reason).toContain("aws_access_key_id");
      expect(body.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockPatchItems).not.toHaveBeenCalled();
    });

    it("422 when title is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({ ...validBody, title: "Incident — key sk-ant-abcdef0123456789ABCDEFabcdef0123" })
      );
      expect(res.status).toBe(422);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("422 when an item's body is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              kind: "timeline_event",
              body: "token ghp_abcdef0123456789ABCDEFabcdef01234567",
            },
          ],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(mockPatchItems).not.toHaveBeenCalled();
    });

    it("422 when an item's mechanism is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              kind: "hypothesis",
              body: "pool exhaustion",
              mechanism: "token ghp_abcdef0123456789ABCDEFabcdef01234567",
              state: "open",
            },
          ],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("422 when a link's targetSlug is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          links: [{ targetSlug: "token ghp_abcdef0123456789ABCDEFabcdef01234567", role: "related" }],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("rejects the whole batch if only one of several items is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            { kind: "timeline_event", body: "A perfectly fine note" },
            { kind: "timeline_event", body: "token ghp_abcdef0123456789ABCDEFabcdef01234567" },
          ],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("allows prose that merely mentions the word password", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ kind: "timeline_event", body: "Reset your password on the settings page." }],
        })
      );
      expect(res.status).toBe(200);
      expect(mockPatchItems).toHaveBeenCalled();
    });
  });

  describe("400 on a malformed body", () => {
    it("rejects an out-of-enum severity", async () => {
      const res = await POST(postReq({ ...validBody, severity: "apocalyptic" }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("rejects an out-of-enum item kind", async () => {
      const res = await POST(postReq({ ...validBody, items: [{ kind: "bogus", body: "x" }] }));
      expect(res.status).toBe(400);
    });

    it("rejects an out-of-enum item state", async () => {
      const res = await POST(
        postReq({ ...validBody, items: [{ kind: "hypothesis", body: "x", state: "bogus" }] })
      );
      expect(res.status).toBe(400);
    });

    it("rejects an item with no kind at all", async () => {
      const res = await POST(postReq({ ...validBody, items: [{ body: "x" }] }));
      expect(res.status).toBe(400);
    });

    it("rejects an invalid firstSeenAt", async () => {
      const res = await POST(postReq({ ...validBody, firstSeenAt: "not-a-date" }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("rejects a link with an out-of-enum role", async () => {
      const res = await POST(postReq({ ...validBody, links: [{ targetSlug: "other", role: "bogus" }] }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("rejects a link with an empty targetSlug", async () => {
      const res = await POST(postReq({ ...validBody, links: [{ targetSlug: "", role: "related" }] }));
      expect(res.status).toBe(400);
    });
  });

  it("200: resolves workspace, upserts the investigation (appending this session id), patches items", async () => {
    const res = await POST(
      postReq({
        ...validBody,
        symptomStatement: "checkout returns 500 intermittently",
        items: [{ kind: "timeline_event", body: "deploy at 14:02 UTC" }],
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledWith(EVE_SESSION_ID);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        slug: SLUG,
        title: "Checkout returns 500",
        symptomStatement: "checkout returns 500 intermittently",
        appendSessionId: SESSION_ID,
      })
    );
    expect(mockPatchItems).toHaveBeenCalledWith(INVESTIGATION_ID, [
      { kind: "timeline_event", body: "deploy at 14:02 UTC" },
    ]);
    const body = await res.json();
    expect(body.investigation).toMatchObject({ slug: SLUG });
  });

  describe("relaying store refusals honestly — all six patchInvestigationItems arrays pass through, always present", () => {
    it("200 with every array present even when all are empty", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toEqual([]);
      expect(body.skippedHumanAuthorityIds).toEqual([]);
      expect(body.skippedEvidenceImmutableIds).toEqual([]);
      expect(body.skippedHypothesisNeedsEvidence).toEqual([]);
      expect(body.skippedKindChangeIds).toEqual([]);
      expect(body.unmatchedIds).toEqual([]);
      expect(body.skippedLinks).toEqual([]);
    });

    it("surfaces skippedHumanAuthorityIds", async () => {
      mockPatchItems.mockResolvedValue({
        ...EMPTY_PATCH_RESULT,
        skippedHumanAuthorityIds: ["item-1"],
      } as never);
      const res = await POST(postReq({ ...validBody, items: [{ id: "item-1", kind: "hypothesis", body: "x" }] }));
      const body = await res.json();
      expect(body.skippedHumanAuthorityIds).toEqual(["item-1"]);
    });

    it("surfaces skippedEvidenceImmutableIds", async () => {
      mockPatchItems.mockResolvedValue({
        ...EMPTY_PATCH_RESULT,
        skippedEvidenceImmutableIds: ["ev-1"],
      } as never);
      const res = await POST(postReq({ ...validBody, items: [{ kind: "evidence", body: "x" }] }));
      const body = await res.json();
      expect(body.skippedEvidenceImmutableIds).toEqual(["ev-1"]);
    });

    it("surfaces skippedHypothesisNeedsEvidence", async () => {
      mockPatchItems.mockResolvedValue({
        ...EMPTY_PATCH_RESULT,
        skippedHypothesisNeedsEvidence: ["new"],
      } as never);
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ kind: "hypothesis", body: "pool exhaustion", state: "supported", evidenceRefs: [] }],
        })
      );
      const body = await res.json();
      expect(body.skippedHypothesisNeedsEvidence).toEqual(["new"]);
    });

    it("surfaces skippedKindChangeIds", async () => {
      mockPatchItems.mockResolvedValue({
        ...EMPTY_PATCH_RESULT,
        skippedKindChangeIds: ["hyp-1"],
      } as never);
      const res = await POST(
        postReq({ ...validBody, items: [{ id: "hyp-1", kind: "evidence", body: "x" }] })
      );
      const body = await res.json();
      expect(body.skippedKindChangeIds).toEqual(["hyp-1"]);
    });

    it("surfaces unmatchedIds", async () => {
      mockPatchItems.mockResolvedValue({
        ...EMPTY_PATCH_RESULT,
        unmatchedIds: ["no-such-item"],
      } as never);
      const res = await POST(
        postReq({ ...validBody, items: [{ id: "no-such-item", kind: "timeline_event", body: "x" }] })
      );
      const body = await res.json();
      expect(body.unmatchedIds).toEqual(["no-such-item"]);
    });

    it("surfaces applied ids", async () => {
      mockPatchItems.mockResolvedValue({ ...EMPTY_PATCH_RESULT, applied: ["new-item"] } as never);
      const res = await POST(postReq({ ...validBody, items: [{ kind: "timeline_event", body: "x" }] }));
      const body = await res.json();
      expect(body.applied).toEqual(["new-item"]);
    });
  });

  describe("links (Self-Review S1: recurrence_of/related edges resolved server-side, never a hard failure)", () => {
    it("resolves targetSlug to an id within the SAME workspace and calls linkInvestigations", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          links: [{ targetSlug: TARGET_INVESTIGATION.slug, role: "recurrence_of" }],
        })
      );
      expect(res.status).toBe(200);
      expect(mockGetBySlug).toHaveBeenCalledWith(WS, TARGET_INVESTIGATION.slug);
      expect(mockLinkInvestigations).toHaveBeenCalledWith(
        INVESTIGATION_ID,
        TARGET_INVESTIGATION_ID,
        "recurrence_of"
      );
      const body = await res.json();
      expect(body.skippedLinks).toEqual([]);
    });

    it("reports an unresolvable targetSlug in skippedLinks — never a hard failure", async () => {
      const res = await POST(
        postReq({ ...validBody, links: [{ targetSlug: "no-such-investigation", role: "related" }] })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skippedLinks).toEqual(["no-such-investigation"]);
      expect(mockLinkInvestigations).not.toHaveBeenCalled();
      // The investigation write itself still succeeded.
      expect(body.investigation).toMatchObject({ slug: SLUG });
    });

    it("a mix of resolvable and unresolvable links: one links, one is skipped, neither blocks the other", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          links: [
            { targetSlug: TARGET_INVESTIGATION.slug, role: "related" },
            { targetSlug: "no-such-investigation", role: "related" },
          ],
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockLinkInvestigations).toHaveBeenCalledTimes(1);
      expect(body.skippedLinks).toEqual(["no-such-investigation"]);
    });

    it("502 when linkInvestigations throws", async () => {
      mockLinkInvestigations.mockRejectedValue(new Error("pg down"));
      const res = await POST(
        postReq({ ...validBody, links: [{ targetSlug: TARGET_INVESTIGATION.slug, role: "related" }] })
      );
      expect(res.status).toBe(502);
    });
  });

  it("502 when upsertInvestigation throws", async () => {
    mockUpsert.mockRejectedValue(new Error("pg down"));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(502);
  });

  it("502 when patchInvestigationItems throws", async () => {
    mockPatchItems.mockRejectedValue(new Error("pg down"));
    const res = await POST(postReq({ ...validBody, items: [{ kind: "timeline_event", body: "x" }] }));
    expect(res.status).toBe(502);
  });

  describe("anchor (conversation -> investigation anchor)", () => {
    it("400 when anchor is present but not a boolean, and never writes", async () => {
      const res = await POST(postReq({ ...validBody, anchor: "yes" }));
      expect(res.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("omitted anchor leaves the session's anchor completely untouched", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      expect(mockSetAnchor).not.toHaveBeenCalled();
      expect(mockClearAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body).not.toHaveProperty("anchor");
    });

    it("anchor: true anchors the session to THIS call's investigation and reports it back", async () => {
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(200);
      expect(mockSetAnchor).toHaveBeenCalledWith(SESSION_ID, INVESTIGATION_ID);
      expect(mockClearAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.anchor).toEqual({ investigationId: INVESTIGATION_ID });
    });

    it("anchor: false clears any existing anchor and reports anchor: null", async () => {
      const res = await POST(postReq({ ...validBody, anchor: false }));
      expect(res.status).toBe(200);
      expect(mockClearAnchor).toHaveBeenCalledWith(SESSION_ID);
      expect(mockSetAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.anchor).toBeNull();
    });

    it("refuses to anchor to an investigation from ANOTHER workspace (tenancy boundary, defense in depth)", async () => {
      mockUpsert.mockResolvedValue({ ...EXISTING_INVESTIGATION, workspaceId: OTHER_WS } as never);
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(404);
      expect(mockSetAnchor).not.toHaveBeenCalled();
    });

    it("502 when setSessionInvestigationAnchor throws", async () => {
      mockSetAnchor.mockRejectedValue(new Error("pg down"));
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(502);
    });

    it("clears BEFORE the upsert, not after", async () => {
      const callOrder: string[] = [];
      mockClearAnchor.mockImplementation(async () => {
        callOrder.push("clear");
        return true;
      });
      mockUpsert.mockImplementation(async () => {
        callOrder.push("upsert");
        return EXISTING_INVESTIGATION as never;
      });
      await POST(postReq({ ...validBody, anchor: false }));
      expect(callOrder).toEqual(["clear", "upsert"]);
    });

    describe("pure anchor: false clear — no slug at all", () => {
      it("200 with anchor: null from a body carrying only eveSessionId and anchor: false — no slug required", async () => {
        const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.anchor).toBeNull();
        expect(mockClearAnchor).toHaveBeenCalledWith(SESSION_ID);
      });

      it("never touches upsertInvestigation or patchInvestigationItems for a slug-less clear", async () => {
        await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(mockPatchItems).not.toHaveBeenCalled();
      });

      it("400 when content fields are sent alongside a slug-less anchor: false — never silently dropped", async () => {
        const res = await POST(
          postReq({
            eveSessionId: EVE_SESSION_ID,
            anchor: false,
            items: [{ kind: "timeline_event", body: "orphaned content" }],
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/slug is required/i);
        expect(mockClearAnchor).not.toHaveBeenCalled();
      });

      it("400 when links are sent alongside a slug-less anchor: false", async () => {
        const res = await POST(
          postReq({
            eveSessionId: EVE_SESSION_ID,
            anchor: false,
            links: [{ targetSlug: "other", role: "related" }],
          })
        );
        expect(res.status).toBe(400);
        expect(mockClearAnchor).not.toHaveBeenCalled();
      });
    });
  });
});
