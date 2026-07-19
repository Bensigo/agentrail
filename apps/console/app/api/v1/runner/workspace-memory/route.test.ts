import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  retrieveMemory: vi.fn(),
  getJaceSessionByEveSessionId: vi.fn(),
}));

import { GET } from "./route";
import { retrieveMemory, getJaceSessionByEveSessionId } from "@agentrail/db-postgres";

const mockRetrieve = vi.mocked(retrieveMemory);
const mockGetSession = vi.mocked(getJaceSessionByEveSessionId);

const WS = "00000000-0000-0000-0000-000000000001";
const EVE_SESSION_ID = "eve-session-1";

// Central-secret auth (2026-07-20 fix): the route now authenticates via
// requireJaceConsoleSecret / JACE_CONSOLE_TOKEN instead of a per-workspace
// bearer api_key — the workspace it used to read straight off that bearer is
// now resolved server-side from a required `eveSessionId` query param via
// the jace_sessions ledger, same resolution chain the other Jace-coordinator
// routes use. Real helper, real env var, real header — same idiom as
// fleet/workspace-tokens/sync/route.test.ts uses for its own shared secret.
const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

// No default value on `eveSessionId` (same reasoning as the `token` param
// below): a default would NOT distinguish "explicitly omitted, to test the
// missing-param 400" from "caller didn't bother passing it" (JS applies a
// default to an explicit `undefined` property too). Every call site below
// passes `eveSessionId: EVE_SESSION_ID` explicitly except the one test that
// means to omit it.
function req(opts: {
  query?: string;
  eveSessionId?: string;
  token?: string;
} = {}): NextRequest {
  const { query, eveSessionId, token } = opts;
  const params = new URLSearchParams();
  if (eveSessionId !== undefined) params.set("eveSessionId", eveSessionId);
  if (query !== undefined) params.set("query", query);
  const qs = params.toString();
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  return new NextRequest(
    `http://localhost/api/v1/runner/workspace-memory${qs ? `?${qs}` : ""}`,
    { method: "GET", headers }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  mockGetSession.mockResolvedValue({ workspaceId: WS } as never);
  mockRetrieve.mockResolvedValue([] as never);
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

describe("GET /api/v1/runner/workspace-memory", () => {
  describe("auth (central JACE_CONSOLE_TOKEN secret, 2026-07-20)", () => {
    it("401 when JACE_CONSOLE_TOKEN is unset (fail closed, never 'open') — even the objectively correct secret is rejected, and never touches the db", async () => {
      delete process.env[ENV_KEY];

      const res = await GET(req({ token: SECRET }));

      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("401 when no Authorization header is sent, and never touches the db", async () => {
      const res = await GET(req({ token: undefined }));

      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("401 on a wrong secret, and never touches the db", async () => {
      const res = await GET(req({ token: "wrong-secret" }));

      expect(res.status).toBe(401);
      expect(mockGetSession).not.toHaveBeenCalled();
    });
  });

  describe("tenant resolution (eveSessionId -> jace_sessions ledger, never a caller-supplied workspaceId)", () => {
    it("400 when eveSessionId is missing", async () => {
      const res = await GET(req({ token: SECRET }));

      expect(res.status).toBe(400);
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    it("400 when eveSessionId is blank/whitespace", async () => {
      const res = await GET(req({ token: SECRET, eveSessionId: "   " }));

      expect(res.status).toBe(400);
    });

    it("404 when no session exists for this eveSessionId", async () => {
      mockGetSession.mockResolvedValue(null);

      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID }));

      expect(res.status).toBe(404);
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("404 when the session has no resolved workspace yet (intro session, cold-start)", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: null } as never);

      const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID }));

      expect(res.status).toBe(404);
      expect(mockRetrieve).not.toHaveBeenCalled();
    });

    it("resolves the workspace from the session ledger, never trusting a caller-supplied workspaceId directly (there is no such input at all)", async () => {
      mockGetSession.mockResolvedValue({ workspaceId: WS } as never);

      await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID }));

      expect(mockGetSession).toHaveBeenCalledWith(EVE_SESSION_ID);
      expect(mockRetrieve).toHaveBeenCalledWith(WS, "", expect.any(Object));
    });
  });

  it("returns 200 with retrieveMemory's ranked items, scoped to the ledgered workspace + the query", async () => {
    const rows = [
      { id: "m1", source: "human", content: "prefer squash merges", type: "preference" },
      { id: "m2", source: "jace", content: "flag defaults OFF", type: "decision" },
    ];
    mockRetrieve.mockResolvedValue(rows as never);

    const res = await GET(
      req({ token: SECRET, eveSessionId: EVE_SESSION_ID, query: "merge strategy" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: "m1" });
    expect(mockRetrieve).toHaveBeenCalledWith(
      WS,
      "merge strategy",
      expect.objectContaining({ k: expect.any(Number) })
    );
  });

  it("passes an empty string to retrieveMemory when query is missing", async () => {
    const res = await GET(req({ token: SECRET, eveSessionId: EVE_SESSION_ID }));
    expect(res.status).toBe(200);
    expect(mockRetrieve).toHaveBeenCalledWith(WS, "", expect.any(Object));
  });

  it("502 when the memory store errors", async () => {
    mockRetrieve.mockRejectedValue(new Error("pg down"));
    const res = await GET(
      req({ token: SECRET, eveSessionId: EVE_SESSION_ID, query: "merge strategy" })
    );
    expect(res.status).toBe(502);
  });
});
