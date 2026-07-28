import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getBriefBySlug: vi.fn(),
  getBriefById: vi.fn(),
  listBriefs: vi.fn(),
  searchBriefs: vi.fn(),
  upsertBrief: vi.fn(),
  patchBriefItems: vi.fn(),
  setSessionBriefAnchor: vi.fn(),
  clearSessionBriefAnchor: vi.fn(),
  computeBriefReadiness: vi.fn(),
}));

import { GET, POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getBriefBySlug,
  getBriefById,
  listBriefs,
  searchBriefs,
  upsertBrief,
  patchBriefItems,
  setSessionBriefAnchor,
  clearSessionBriefAnchor,
  computeBriefReadiness,
} from "@agentrail/db-postgres";

const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);
const mockGetBriefBySlug = vi.mocked(getBriefBySlug);
const mockGetBriefById = vi.mocked(getBriefById);
const mockListBriefs = vi.mocked(listBriefs);
const mockSearchBriefs = vi.mocked(searchBriefs);
const mockUpsertBrief = vi.mocked(upsertBrief);
const mockPatchBriefItems = vi.mocked(patchBriefItems);
const mockSetAnchor = vi.mocked(setSessionBriefAnchor);
const mockClearAnchor = vi.mocked(clearSessionBriefAnchor);
const mockComputeReadiness = vi.mocked(computeBriefReadiness);

const WS = "00000000-0000-0000-0000-000000000001";
const OTHER_WS = "00000000-0000-0000-0000-000000000002";
const SESSION_ID = "00000000-0000-0000-0000-0000000005e5";
const EVE_SESSION_ID = "eve-session-1";
const BRIEF_ID = "00000000-0000-0000-0000-0000000000b1";
const SLUG = "blog";

// Central-secret auth, same idiom as workspace-memory/repo-wiki's own tests.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

const EXISTING_BRIEF = {
  id: BRIEF_ID,
  workspaceId: WS,
  repositoryId: null,
  slug: SLUG,
  title: "Blog",
  status: "draft",
  openQuestion: "",
  grounding: { wikiPageSlugs: [], memoryItemIds: [], commitSha: null },
  jaceSessionIds: [],
  createdAt: new Date("2026-07-27T00:00:00Z"),
  updatedAt: new Date("2026-07-27T00:00:00Z"),
};

const READY: { ready: true; blockingItems: [] } = { ready: true, blockingItems: [] };

const OPEN_UNKNOWN_ITEM = {
  id: "item-unknown-1",
  briefId: BRIEF_ID,
  area: "scope",
  statement: "Does the approver need to be a repo admin, or just a workspace member?",
  evidence: "not sure yet who should be allowed to approve",
  kind: "unknown",
  state: "open",
  resolution: null,
  authority: "jace",
  createdAt: new Date("2026-07-27T00:00:00Z"),
  updatedAt: new Date("2026-07-27T00:00:00Z"),
};

const NOT_READY = { ready: false, blockingItems: [OPEN_UNKNOWN_ITEM] };

function getReq(opts: {
  eveSessionId?: string;
  mode?: string;
  slug?: string;
  query?: string;
  token?: string;
} = {}): NextRequest {
  const { eveSessionId, mode, slug, query, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  if (mode !== undefined) params.set("mode", mode);
  if (slug !== undefined) params.set("slug", slug);
  if (query !== undefined) params.set("query", query);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/runner/briefs${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers,
  });
}

function postReq(body: unknown, token: string | undefined = SECRET): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost/api/v1/runner/briefs", {
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
    anchoredBriefId: null,
  } as never);
  mockGetBriefBySlug.mockResolvedValue(EXISTING_BRIEF as never);
  mockGetBriefById.mockResolvedValue(EXISTING_BRIEF as never);
  mockListBriefs.mockResolvedValue([EXISTING_BRIEF] as never);
  mockSearchBriefs.mockResolvedValue([EXISTING_BRIEF] as never);
  mockUpsertBrief.mockResolvedValue(EXISTING_BRIEF as never);
  mockPatchBriefItems.mockResolvedValue({
    upserted: [],
    skippedHumanAuthorityIds: [],
    skippedUnknownResolvedIds: [],
  } as never);
  mockSetAnchor.mockResolvedValue(true as never);
  mockClearAnchor.mockResolvedValue(true as never);
  mockComputeReadiness.mockResolvedValue(READY as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/briefs", () => {
  describe("auth + tenant resolution (shared with POST, same posture as workspace-memory/repo-wiki)", () => {
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

    it("404 when no session exists for this eveSessionId", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      expect(res.status).toBe(404);
      expect(mockListBriefs).not.toHaveBeenCalled();
    });

    it("404 when the session has no resolved workspace yet (intro session)", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: null } as never);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      expect(res.status).toBe(404);
      expect(mockListBriefs).not.toHaveBeenCalled();
    });
  });

  it("400 on an invalid mode", async () => {
    const res = await GET(
      getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "bogus" })
    );
    expect(res.status).toBe(400);
  });

  describe("mode=list", () => {
    it("200 with every brief for the workspace, no query needed", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("list");
      expect(body.briefs).toHaveLength(1);
      expect(mockListBriefs).toHaveBeenCalledWith(WS);
    });

    it("502 when listBriefs throws", async () => {
      mockListBriefs.mockRejectedValue(new Error("pg down"));
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      expect(res.status).toBe(502);
    });

    it("does not compute or attach per-brief readiness — the compact index never pulls the per-brief items query readiness needs", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "list" })
      );
      const body = await res.json();
      expect(body.briefs[0].readiness).toBeUndefined();
      expect(mockComputeReadiness).not.toHaveBeenCalled();
    });
  });

  describe("mode=get", () => {
    it("400 when slug is missing", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get" })
      );
      expect(res.status).toBe(400);
      expect(mockGetBriefBySlug).not.toHaveBeenCalled();
    });

    it("404 when no brief matches the slug", async () => {
      mockGetBriefBySlug.mockResolvedValue(null);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
      );
      expect(res.status).toBe(404);
    });

    it("200 with the whole brief when found", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("get");
      expect(body.brief).toMatchObject({ slug: SLUG });
      expect(mockGetBriefBySlug).toHaveBeenCalledWith(WS, SLUG);
    });

    describe("readiness (server-computed via computeBriefReadiness, never derived by the caller)", () => {
      it("includes readiness: { ready: true, blockingItems: [] } when the brief has no open unknowns", async () => {
        mockComputeReadiness.mockResolvedValue(READY as never);
        const res = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.readiness).toEqual({ ready: true, blockingItems: [] });
        expect(mockComputeReadiness).toHaveBeenCalledWith(BRIEF_ID);
      });

      it("includes readiness: { ready: false, blockingItems: [...] } naming the actual open+unknown item", async () => {
        mockComputeReadiness.mockResolvedValue(NOT_READY as never);
        const res = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.readiness.ready).toBe(false);
        expect(body.readiness.blockingItems).toHaveLength(1);
        expect(body.readiness.blockingItems[0]).toMatchObject({
          id: "item-unknown-1",
          kind: "unknown",
          state: "open",
          statement: OPEN_UNKNOWN_ITEM.statement,
        });
      });

      it("becomes ready: true once the last open unknown is marked out-of-scope (the store already recomputes; the route just relays it)", async () => {
        // Simulate the two calls a caller makes: first a get sees the brief
        // blocked, then (after marking the item out-of-scope elsewhere) a
        // second get sees it clear — this route never caches or short-circuits
        // readiness between calls, it always asks the store fresh.
        mockComputeReadiness.mockResolvedValueOnce(NOT_READY as never);
        const first = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
        );
        const firstBody = await first.json();
        expect(firstBody.readiness.ready).toBe(false);

        mockComputeReadiness.mockResolvedValueOnce(READY as never);
        const second = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
        );
        const secondBody = await second.json();
        expect(secondBody.readiness).toEqual({ ready: true, blockingItems: [] });
      });

      it("502 when computeBriefReadiness throws", async () => {
        mockComputeReadiness.mockRejectedValue(new Error("pg down"));
        const res = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "get", slug: SLUG })
        );
        expect(res.status).toBe(502);
      });
    });
  });

  describe("mode=search", () => {
    it("400 when query is missing", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search" })
      );
      expect(res.status).toBe(400);
      expect(mockSearchBriefs).not.toHaveBeenCalled();
    });

    it("200 with matching briefs", async () => {
      const res = await GET(
        getReq({
          token: SECRET,
          eveSessionId: EVE_SESSION_ID,
          mode: "search",
          query: "blog",
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("search");
      expect(body.briefs).toHaveLength(1);
      expect(mockSearchBriefs).toHaveBeenCalledWith(WS, "blog");
    });

    it("does not compute or attach readiness — search is disambiguation ('which brief'), not the gate ('is this brief ready')", async () => {
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "search", query: "blog" })
      );
      const body = await res.json();
      expect(body.readiness).toBeUndefined();
      expect(mockComputeReadiness).not.toHaveBeenCalled();
    });
  });

  describe("mode=anchor", () => {
    it("returns null when the session has no brief anchored yet", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: null,
      } as never);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe("anchor");
      expect(body.anchor).toBeNull();
    });

    it("skips the getBriefById lookup entirely when there's no anchor (no wasted query)", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: null,
      } as never);
      await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(mockGetBriefById).not.toHaveBeenCalled();
    });

    it("skips computeBriefReadiness too when there's no anchor (nothing to compute readiness FOR)", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: null,
      } as never);
      await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(mockComputeReadiness).not.toHaveBeenCalled();
    });

    it("returns the FULL anchored brief — the same shape mode=get returns — not just an id, so resume needs no follow-up call", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: BRIEF_ID,
      } as never);
      const anchoredBriefWithItems = {
        ...EXISTING_BRIEF,
        items: [
          {
            id: "item-1",
            briefId: BRIEF_ID,
            area: "scope",
            statement: "single approver for now",
            evidence: "for now since am the only one approve to publish it",
            kind: "required",
            state: "open",
            resolution: null,
            authority: "jace",
            createdAt: new Date("2026-07-27T00:00:00Z"),
            updatedAt: new Date("2026-07-27T00:00:00Z"),
          },
        ],
      };
      mockGetBriefById.mockResolvedValue(anchoredBriefWithItems as never);

      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(mockGetBriefById).toHaveBeenCalledWith(WS, BRIEF_ID);
      // The whole point: items, openQuestion, grounding all present WITHOUT
      // a follow-up call — resume needs to act on this immediately.
      expect(body.anchor.brief.slug).toBe(SLUG);
      expect(body.anchor.brief.openQuestion).toBe("");
      expect(body.anchor.brief.grounding).toEqual({
        wikiPageSlugs: [],
        memoryItemIds: [],
        commitSha: null,
      });
      expect(body.anchor.brief.items).toHaveLength(1);
      expect(body.anchor.brief.items[0].statement).toBe("single approver for now");
      // readiness rides alongside — same as mode=get, same reasoning (server-
      // computed, never derived by scanning the items above yourself).
      expect(body.anchor.readiness).toEqual({ ready: true, blockingItems: [] });
      expect(mockComputeReadiness).toHaveBeenCalledWith(BRIEF_ID);
    });

    describe("readiness on the anchored brief (same server-computed contract as mode=get)", () => {
      beforeEach(() => {
        mockGetSession.mockResolvedValue({
          id: SESSION_ID,
          workspaceId: WS,
          anchoredBriefId: BRIEF_ID,
        } as never);
      });

      it("ready: false names the actual blocking item when the anchored brief still has an open unknown", async () => {
        mockComputeReadiness.mockResolvedValue(NOT_READY as never);
        const res = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.anchor.readiness.ready).toBe(false);
        expect(body.anchor.readiness.blockingItems).toHaveLength(1);
        expect(body.anchor.readiness.blockingItems[0]).toMatchObject({
          id: "item-unknown-1",
          kind: "unknown",
          state: "open",
        });
      });

      it("ready: true once the anchored brief's last open unknown clears", async () => {
        mockComputeReadiness.mockResolvedValue(READY as never);
        const res = await GET(
          getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
        );
        const body = await res.json();
        expect(body.anchor.readiness).toEqual({ ready: true, blockingItems: [] });
      });
    });

    it("returns null (not an error) when the anchored brief no longer resolves — e.g. it was deleted", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: BRIEF_ID,
      } as never);
      mockGetBriefById.mockResolvedValue(null);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.anchor).toBeNull();
      // Nothing to compute readiness FOR when there's no brief — never a
      // wasted call.
      expect(mockComputeReadiness).not.toHaveBeenCalled();
    });

    it("scopes the lookup to the caller's OWN workspace, never another tenant's", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: BRIEF_ID,
      } as never);
      await GET(getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" }));
      expect(mockGetBriefById).toHaveBeenCalledWith(WS, BRIEF_ID);
      expect(mockGetBriefById).not.toHaveBeenCalledWith(OTHER_WS, BRIEF_ID);
    });

    it("404s the same as every other mode when there's no session", async () => {
      mockGetSession.mockResolvedValue(null);
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(404);
    });

    it("502 when getBriefById throws", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: BRIEF_ID,
      } as never);
      mockGetBriefById.mockRejectedValue(new Error("pg down"));
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(502);
    });

    it("502 when computeBriefReadiness throws for the anchored brief", async () => {
      mockGetSession.mockResolvedValue({
        id: SESSION_ID,
        workspaceId: WS,
        anchoredBriefId: BRIEF_ID,
      } as never);
      mockComputeReadiness.mockRejectedValue(new Error("pg down"));
      const res = await GET(
        getReq({ token: SECRET, eveSessionId: EVE_SESSION_ID, mode: "anchor" })
      );
      expect(res.status).toBe(502);
    });
  });
});

describe("POST /api/v1/runner/briefs", () => {
  const validBody = {
    eveSessionId: EVE_SESSION_ID,
    slug: SLUG,
    title: "Blog",
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

  it("404 when no session exists for this eveSessionId", async () => {
    mockGetSession.mockResolvedValue(null);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockUpsertBrief).not.toHaveBeenCalled();
  });

  it("404 when the session has no resolved workspace yet", async () => {
    mockGetSession.mockResolvedValue({ workspaceId: null } as never);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect(mockUpsertBrief).not.toHaveBeenCalled();
  });

  describe("status rejection (contract correction: status is console-only, never accepted here)", () => {
    it("400 when status is present in the body, and never writes", async () => {
      const res = await POST(postReq({ ...validBody, status: "ready" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/status/i);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
    });

    it("400 even when status is an unexpected shape (never silently dropped)", async () => {
      const res = await POST(postReq({ ...validBody, status: null }));
      expect(res.status).toBe(400);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
    });
  });

  describe("title inheritance", () => {
    it("400 when title is omitted and no brief exists yet for this slug", async () => {
      mockGetBriefBySlug.mockResolvedValue(null);
      const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, slug: SLUG }));
      expect(res.status).toBe(400);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
    });

    it("inherits the existing title when omitted on a later call", async () => {
      const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, slug: SLUG }));
      expect(res.status).toBe(200);
      expect(mockUpsertBrief).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WS, slug: SLUG, title: EXISTING_BRIEF.title })
      );
    });

    it("uses the supplied title over the existing one when both are present", async () => {
      const res = await POST(postReq({ ...validBody, title: "New Blog Title" }));
      expect(res.status).toBe(200);
      expect(mockUpsertBrief).toHaveBeenCalledWith(
        expect.objectContaining({ title: "New Blog Title" })
      );
    });
  });

  describe("secret scan on write (mirrors ingest/memory-items, #1032)", () => {
    it("422 and does not write when an item's statement is credential-shaped", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              area: "constraints",
              statement: "prod aws key is AKIAIOSFODNN7EXAMPLE, do not lose it",
              kind: "required",
            },
          ],
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/credential-shaped/i);
      expect(body.reason).toContain("aws_access_key_id");
      expect(body.reason).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("422 and does not write when an item's evidence is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              area: "constraints",
              statement: "Only one approver for now",
              evidence: "token ghp_abcdef0123456789ABCDEFabcdef01234567",
              kind: "required",
            },
          ],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
    });

    it("422 and does not write when title is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          title: "Blog project — key sk-ant-abcdef0123456789ABCDEFabcdef0123",
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toMatch(/credential-shaped/i);
      expect(body.reason).toContain("anthropic_key");
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
    });

    it("422 and does not write when openQuestion is credential-shaped — the most likely real case, since it's the model's own echoed-back question", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          openQuestion:
            "you mentioned sk-ant-abcdef0123456789ABCDEFabcdef0123 — is that the key the blog should use?",
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.reason).toContain("anthropic_key");
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
    });

    it("422 and does not write when a grounding string field is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          grounding: {
            wikiPageSlugs: ["wiki/overview"],
            memoryItemIds: [],
            commitSha: "token ghp_abcdef0123456789ABCDEFabcdef01234567",
          },
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.reason).toContain("github_token");
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
    });

    it("rejects the whole batch if only one of several items is credential-shaped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            { area: "problem", statement: "A perfectly fine statement", kind: "required" },
            {
              area: "constraints",
              statement: "token ghp_abcdef0123456789ABCDEFabcdef01234567",
              kind: "required",
            },
          ],
        })
      );
      expect(res.status).toBe(422);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
      expect(mockPatchBriefItems).not.toHaveBeenCalled();
    });

    it("allows prose that merely mentions the word password", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              area: "constraints",
              statement: "Reset your password on the settings page.",
              kind: "required",
            },
          ],
        })
      );
      expect(res.status).toBe(200);
      expect(mockPatchBriefItems).toHaveBeenCalled();
    });
  });

  describe("400 on a malformed item", () => {
    it("rejects an out-of-enum area", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ area: "bogus", statement: "x", kind: "required" }],
        })
      );
      expect(res.status).toBe(400);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
    });

    it("rejects an out-of-enum kind", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ area: "problem", statement: "x", kind: "bogus" }],
        })
      );
      expect(res.status).toBe(400);
    });

    it("rejects an empty statement", async () => {
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ area: "problem", statement: "", kind: "required" }],
        })
      );
      expect(res.status).toBe(400);
    });
  });

  it("200: resolves workspace, upserts the brief, patches items, and returns the upserted brief", async () => {
    const res = await POST(
      postReq({
        ...validBody,
        openQuestion: "single approver ok?",
        items: [{ area: "constraints", statement: "single approver for now", kind: "required" }],
      })
    );
    expect(res.status).toBe(200);
    expect(mockGetSession).toHaveBeenCalledWith(EVE_SESSION_ID);
    expect(mockUpsertBrief).toHaveBeenCalledWith({
      workspaceId: WS,
      slug: SLUG,
      title: "Blog",
      openQuestion: "single approver ok?",
      grounding: undefined,
    });
    expect(mockPatchBriefItems).toHaveBeenCalledWith(BRIEF_ID, [
      { area: "constraints", statement: "single approver for now", kind: "required" },
    ]);
    const body = await res.json();
    expect(body.brief).toMatchObject({ slug: SLUG });
  });

  describe("relaying store refusals honestly (never swallowed)", () => {
    it("200 with skippedHumanAuthorityIds surfaced when a human-locked item's write is dropped", async () => {
      mockPatchBriefItems.mockResolvedValue({
        upserted: [],
        skippedHumanAuthorityIds: ["item-1"],
        skippedUnknownResolvedIds: [],
      } as never);
      const res = await POST(
        postReq({
          ...validBody,
          items: [{ id: "item-1", area: "problem", statement: "edited", kind: "required" }],
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skippedHumanAuthorityIds).toEqual(["item-1"]);
      expect(body.skippedUnknownResolvedIds).toEqual([]);
    });

    it("200 with skippedUnknownResolvedIds surfaced when an unknown-kind item can't resolve", async () => {
      mockPatchBriefItems.mockResolvedValue({
        upserted: [],
        skippedHumanAuthorityIds: [],
        skippedUnknownResolvedIds: ["item-2"],
      } as never);
      const res = await POST(
        postReq({
          ...validBody,
          items: [
            {
              id: "item-2",
              area: "problem",
              statement: "still unclear",
              kind: "unknown",
              state: "resolved",
            },
          ],
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skippedUnknownResolvedIds).toEqual(["item-2"]);
      expect(body.skippedHumanAuthorityIds).toEqual([]);
    });

    it("both skip-lists are present in a 200 body even when both are empty", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.skippedHumanAuthorityIds).toEqual([]);
      expect(body.skippedUnknownResolvedIds).toEqual([]);
    });
  });

  it("502 when upsertBrief throws", async () => {
    mockUpsertBrief.mockRejectedValue(new Error("pg down"));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(502);
  });

  it("502 when patchBriefItems throws", async () => {
    mockPatchBriefItems.mockRejectedValue(new Error("pg down"));
    const res = await POST(
      postReq({
        ...validBody,
        items: [{ area: "problem", statement: "x", kind: "required" }],
      })
    );
    expect(res.status).toBe(502);
  });

  describe("anchor (conversation→brief anchor, design spec step 3)", () => {
    it("400 when anchor is present but not a boolean, and never writes", async () => {
      const res = await POST(postReq({ ...validBody, anchor: "yes" }));
      expect(res.status).toBe(400);
      expect(mockUpsertBrief).not.toHaveBeenCalled();
    });

    it("omitted anchor leaves the session's anchor completely untouched", async () => {
      const res = await POST(postReq(validBody));
      expect(res.status).toBe(200);
      expect(mockSetAnchor).not.toHaveBeenCalled();
      expect(mockClearAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body).not.toHaveProperty("anchor");
    });

    it("anchor: true anchors the session to THIS call's brief and reports it back", async () => {
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(200);
      expect(mockSetAnchor).toHaveBeenCalledWith(SESSION_ID, BRIEF_ID);
      expect(mockClearAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.anchor).toEqual({ briefId: BRIEF_ID });
    });

    it("setting the anchor is idempotent: calling anchor: true twice in a row both succeed and land on the same brief", async () => {
      const first = await POST(postReq({ ...validBody, anchor: true }));
      const second = await POST(postReq({ ...validBody, anchor: true }));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockSetAnchor).toHaveBeenNthCalledWith(1, SESSION_ID, BRIEF_ID);
      expect(mockSetAnchor).toHaveBeenNthCalledWith(2, SESSION_ID, BRIEF_ID);
      const secondBody = await second.json();
      expect(secondBody.anchor).toEqual({ briefId: BRIEF_ID });
    });

    it("anchor: false clears any existing anchor and reports anchor: null", async () => {
      const res = await POST(postReq({ ...validBody, anchor: false }));
      expect(res.status).toBe(200);
      expect(mockClearAnchor).toHaveBeenCalledWith(SESSION_ID);
      expect(mockSetAnchor).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.anchor).toBeNull();
    });

    it("refuses to anchor to a brief from ANOTHER workspace (tenancy boundary, defense in depth)", async () => {
      // Simulate a hypothetical store-layer bug: upsertBrief hands back a
      // brief whose workspaceId does not match the caller's OWN resolved
      // workspace. This should never happen given upsertBrief's own
      // (workspaceId, slug) scoping, but the route re-checks anyway rather
      // than trusting the returned row blindly.
      mockUpsertBrief.mockResolvedValue({
        ...EXISTING_BRIEF,
        workspaceId: OTHER_WS,
      } as never);
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(404);
      expect(mockSetAnchor).not.toHaveBeenCalled();
    });

    it("502 when setSessionBriefAnchor throws", async () => {
      mockSetAnchor.mockRejectedValue(new Error("pg down"));
      const res = await POST(postReq({ ...validBody, anchor: true }));
      expect(res.status).toBe(502);
    });

    it("502 when clearSessionBriefAnchor throws", async () => {
      mockClearAnchor.mockRejectedValue(new Error("pg down"));
      const res = await POST(postReq({ ...validBody, anchor: false }));
      expect(res.status).toBe(502);
    });

    it("clears BEFORE the upsert, not after — the write order the design spec calls for", async () => {
      const callOrder: string[] = [];
      mockClearAnchor.mockImplementation(async () => {
        callOrder.push("clear");
        return true;
      });
      mockUpsertBrief.mockImplementation(async () => {
        callOrder.push("upsert");
        return EXISTING_BRIEF as never;
      });

      await POST(postReq({ ...validBody, anchor: false }));

      expect(callOrder).toEqual(["clear", "upsert"]);
    });

    describe("pure anchor: false clear — no slug at all (design spec step 4: re-confirm on drift, nothing to write yet)", () => {
      it("200 with anchor: null from a body carrying ONLY eveSessionId and anchor: false — no slug required", async () => {
        const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.anchor).toBeNull();
        expect(mockClearAnchor).toHaveBeenCalledWith(SESSION_ID);
      });

      it("never touches upsertBrief or patchBriefItems for a slug-less clear", async () => {
        await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(mockUpsertBrief).not.toHaveBeenCalled();
        expect(mockPatchBriefItems).not.toHaveBeenCalled();
      });

      it("still resolves the session and 404s exactly like every other call when there's no session", async () => {
        mockGetSession.mockResolvedValue(null);
        const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(res.status).toBe(404);
        expect(mockClearAnchor).not.toHaveBeenCalled();
      });

      it("400 when content fields are sent alongside a slug-less anchor: false — never silently dropped", async () => {
        const res = await POST(
          postReq({
            eveSessionId: EVE_SESSION_ID,
            anchor: false,
            items: [{ area: "problem", statement: "orphaned content", kind: "required" }],
          })
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/slug is required/i);
        expect(mockClearAnchor).not.toHaveBeenCalled();
        expect(mockUpsertBrief).not.toHaveBeenCalled();
      });

      it("400 when title is sent alongside a slug-less anchor: false", async () => {
        const res = await POST(
          postReq({ eveSessionId: EVE_SESSION_ID, anchor: false, title: "Orphaned" })
        );
        expect(res.status).toBe(400);
        expect(mockClearAnchor).not.toHaveBeenCalled();
      });

      it("502 when clearSessionBriefAnchor throws on the slug-less path", async () => {
        mockClearAnchor.mockRejectedValue(new Error("pg down"));
        const res = await POST(postReq({ eveSessionId: EVE_SESSION_ID, anchor: false }));
        expect(res.status).toBe(502);
      });

      it("re-anchoring to a different brief (anchor: true with a new slug) is unaffected — the common path still requires and uses slug", async () => {
        const res = await POST(
          postReq({ eveSessionId: EVE_SESSION_ID, slug: "changelog", title: "Changelog", anchor: true })
        );
        expect(res.status).toBe(200);
        expect(mockUpsertBrief).toHaveBeenCalledWith(
          expect.objectContaining({ slug: "changelog", title: "Changelog" })
        );
        expect(mockSetAnchor).toHaveBeenCalledWith(SESSION_ID, BRIEF_ID);
      });
    });
  });
});
