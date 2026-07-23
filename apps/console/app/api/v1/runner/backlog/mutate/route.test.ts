import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getJaceSessionByEveSessionId: vi.fn(),
  getChatIdentityById: vi.fn(),
  getGithubToken: vi.fn(),
  getRepositoryByName: vi.fn(),
}));

import { POST } from "./route";
import {
  getJaceSessionByEveSessionId,
  getChatIdentityById,
  getGithubToken,
  getRepositoryByName,
} from "@agentrail/db-postgres";

const WS = "ws-1";
const EVE = "eve-session-1";
const REPO = "o/r";
const MOCK_TOKEN = "gho_mock_token";

const ENV_KEY = "JACE_CONSOLE_TOKEN";
const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_ENV = process.env[ENV_KEY];

function postReq(body?: unknown, withAuth = true): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/backlog/mutate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withAuth ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function githubJson(status: number, body: unknown = {}): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env[ENV_KEY] = SECRET;
  vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue({ workspaceId: WS, chatIdentityId: "ci-1" } as never);
  vi.mocked(getChatIdentityById).mockResolvedValue({ id: "ci-1", workspaceId: WS } as never);
  vi.mocked(getGithubToken).mockResolvedValue(MOCK_TOKEN);
  vi.mocked(getRepositoryByName).mockResolvedValue({ id: "repo-1", name: REPO } as never);
});

afterEach(() => {
  global.fetch = originalFetch;
  if (ORIGINAL_ENV === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ORIGINAL_ENV;
});

function mockFetchSequence(...responses: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const CLOSE_BODY = { eveSessionId: EVE, repo: REPO, issueNumber: 5, action: "close" };

describe("POST /api/v1/runner/backlog/mutate", () => {
  describe("auth", () => {
    it("401 without auth, never touches db/GitHub", async () => {
      const fetchMock = mockFetchSequence();
      const res = await POST(postReq(CLOSE_BODY, false));
      expect(res.status).toBe(401);
      expect(getJaceSessionByEveSessionId).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("401 when JACE_CONSOLE_TOKEN unset (fail closed)", async () => {
      delete process.env[ENV_KEY];
      const res = await POST(postReq(CLOSE_BODY));
      expect(res.status).toBe(401);
    });
  });

  describe("validation (400, before any GitHub call)", () => {
    it("400 on invalid JSON", async () => {
      const fetchMock = mockFetchSequence();
      const res = await POST(postReq(undefined));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("400 on an unknown action", async () => {
      const res = await POST(postReq({ ...CLOSE_BODY, action: "nuke" }));
      expect(res.status).toBe(400);
    });
    it("400 on a bad repo shape", async () => {
      const res = await POST(postReq({ ...CLOSE_BODY, repo: "not-a-repo" }));
      expect(res.status).toBe(400);
    });
    it("400 on a non-positive issueNumber", async () => {
      const res = await POST(postReq({ ...CLOSE_BODY, issueNumber: 0 }));
      expect(res.status).toBe(400);
    });
    it("400 when add_labels has no labels", async () => {
      const res = await POST(postReq({ eveSessionId: EVE, repo: REPO, issueNumber: 5, action: "add_labels", labels: [] }));
      expect(res.status).toBe(400);
    });
    it("400 when dedupe's canonicalIssue equals issueNumber", async () => {
      const res = await POST(
        postReq({ eveSessionId: EVE, repo: REPO, issueNumber: 5, action: "dedupe", canonicalIssue: 5 }),
      );
      expect(res.status).toBe(400);
    });
    it("400 when close stateReason is bogus", async () => {
      const res = await POST(postReq({ ...CLOSE_BODY, stateReason: "bogus" }));
      expect(res.status).toBe(400);
    });
  });

  describe("tenant + repo resolution", () => {
    it("404 when no session/identity resolves", async () => {
      vi.mocked(getJaceSessionByEveSessionId).mockResolvedValue(null as never);
      vi.mocked(getChatIdentityById).mockResolvedValue(null as never);
      const res = await POST(postReq(CLOSE_BODY));
      expect(res.status).toBe(404);
    });
    it("404 when the repo is not connected to the workspace", async () => {
      vi.mocked(getRepositoryByName).mockResolvedValue(null as never);
      const res = await POST(postReq(CLOSE_BODY));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "repo not connected to this workspace" });
    });
    it("409 when there is no GitHub token", async () => {
      vi.mocked(getGithubToken).mockResolvedValue(null);
      const res = await POST(postReq(CLOSE_BODY));
      expect(res.status).toBe(409);
    });
  });

  describe("add_labels", () => {
    it("POSTs the labels and returns applied:true", async () => {
      const fetchMock = mockFetchSequence(githubJson(200, [{ name: "bug" }]));
      const res = await POST(
        postReq({ eveSessionId: EVE, repo: REPO, issueNumber: 5, action: "add_labels", labels: ["bug", "security"] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(true);
      expect(body.labelsAdded).toEqual(["bug", "security"]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/5/labels`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ labels: ["bug", "security"] });
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    });
  });

  describe("remove_labels", () => {
    it("DELETEs each label; a 404 (label absent) is idempotent, not a failure", async () => {
      const fetchMock = mockFetchSequence(
        githubJson(404, { message: "Label does not exist" }), // "stale" not present -> skip
        githubJson(200, {}), // "wontfix" removed
      );
      const res = await POST(
        postReq({ eveSessionId: EVE, repo: REPO, issueNumber: 5, action: "remove_labels", labels: ["stale", "wontfix"] }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(true);
      expect(body.labelsRemoved).toEqual(["wontfix"]);
      expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    });
  });

  describe("close", () => {
    it("posts the reason comment first, then PATCHes closed with state_reason", async () => {
      const fetchMock = mockFetchSequence(
        githubJson(201, { id: 1 }), // comment
        githubJson(200, { html_url: `https://github.com/${REPO}/issues/5` }), // close
      );
      const res = await POST(
        postReq({ ...CLOSE_BODY, comment: "stale, no longer relevant", stateReason: "not_planned" }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(true);
      expect(body.stateReason).toBe("not_planned");
      expect(body.commentPosted).toBe(true);
      // call 0 = comment, call 1 = PATCH close
      expect(fetchMock.mock.calls[0][0]).toBe(`https://api.github.com/repos/${REPO}/issues/5/comments`);
      const patch = fetchMock.mock.calls[1];
      expect(patch[1].method).toBe("PATCH");
      expect(JSON.parse(patch[1].body as string)).toEqual({ state: "closed", state_reason: "not_planned" });
    });

    it("with no comment, PATCHes closed directly (no comment call)", async () => {
      const fetchMock = mockFetchSequence(githubJson(200, { html_url: "x" }));
      const res = await POST(postReq({ ...CLOSE_BODY, stateReason: "completed" }));
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    });

    it("partial failure: comment lands but close fails -> honest error + warning, no false success", async () => {
      mockFetchSequence(
        githubJson(201, { id: 1 }), // comment ok
        githubJson(500, { message: "boom" }), // close fails
      );
      const res = await POST(postReq({ ...CLOSE_BODY, comment: "closing" }));
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.applied).toBeUndefined();
      expect(body.warnings[0]).toMatch(/comment was posted, but closing/i);
    });

    it("comment fails -> nothing is closed (no PATCH attempted)", async () => {
      const fetchMock = mockFetchSequence(githubJson(500, { message: "boom" }));
      const res = await POST(postReq({ ...CLOSE_BODY, comment: "closing" }));
      expect(res.status).toBe(502);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the comment attempt
    });
  });

  describe("dedupe", () => {
    it("posts a 'Duplicate of #N' comment, then closes as not_planned", async () => {
      const fetchMock = mockFetchSequence(
        githubJson(201, { id: 1 }), // comment
        githubJson(200, { html_url: "x" }), // close
      );
      const res = await POST(
        postReq({
          eveSessionId: EVE,
          repo: REPO,
          issueNumber: 5,
          action: "dedupe",
          canonicalIssue: 3,
          comment: "same webhook bug",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(true);
      expect(body.canonicalIssue).toBe(3);
      expect(body.stateReason).toBe("not_planned");
      const commentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string).body;
      expect(commentBody).toMatch(/Duplicate of #3/);
      expect(commentBody).toMatch(/same webhook bug/);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
        state: "closed",
        state_reason: "not_planned",
      });
    });
  });

  describe("GitHub error classification", () => {
    it("401/403 -> 409 (stale credentials)", async () => {
      mockFetchSequence(githubJson(401, { message: "Bad credentials" }));
      const res = await POST(postReq({ ...CLOSE_BODY }));
      expect(res.status).toBe(409);
    });
    it("404 -> 404 (issue/repo not found)", async () => {
      mockFetchSequence(githubJson(404, { message: "Not Found" }));
      const res = await POST(postReq({ ...CLOSE_BODY }));
      expect(res.status).toBe(404);
    });
    it("429 -> 429 (rate limited)", async () => {
      mockFetchSequence(githubJson(429, { message: "rate limit" }));
      const res = await POST(postReq({ ...CLOSE_BODY }));
      expect(res.status).toBe(429);
    });
    it("a transport error -> 502", async () => {
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET"));
      global.fetch = fetchMock as unknown as typeof fetch;
      const res = await POST(postReq({ ...CLOSE_BODY }));
      expect(res.status).toBe(502);
    });
  });
});
