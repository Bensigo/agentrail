import { describe, it, expect, vi, afterEach } from "vitest";
import { listInstallationRepos, checkRepoAccess } from "./github-repos";

/** A GitHub `GET /installation/repositories` response — WRAPPER object, not
 * a bare array (unlike `/user/repos`). Optional `x-ratelimit-remaining`
 * header for the 403 rate-limit branch. */
function ghInstallationResponse(
  status: number,
  repositories: unknown[],
  opts: { totalCount?: number; rateRemaining?: string } = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "x-ratelimit-remaining"
          ? (opts.rateRemaining ?? null)
          : null,
    },
    json: async () => ({
      total_count: opts.totalCount ?? repositories.length,
      repositories,
    }),
  };
}

function repo(full_name: string, overrides: Record<string, unknown> = {}) {
  return {
    full_name,
    private: true,
    default_branch: "main",
    html_url: `https://github.com/${full_name}`,
    // extra fields the wire contract must strip
    id: 42,
    permissions: { push: true, admin: false, maintain: false },
    ...overrides,
  };
}

function repoPage(n: number, prefix = "acme/repo") {
  return Array.from({ length: n }, (_, i) => repo(`${prefix}-${i}`));
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("listInstallationRepos", () => {
  it("hits GET /installation/repositories (not /user/repos) with the bearer token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, [repo("acme/widgets")]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await listInstallationRepos("installation-token-abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://api.github.com/installation/repositories");
    expect(String(url)).not.toContain("/user/repos");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer installation-token-abc",
    });
  });

  it("unwraps the `{ repositories: [...] }` wrapper shape (not a bare array) and maps to PickerRepo", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        ghInstallationResponse(200, [repo("bensigo/agentrail", { private: false, default_branch: "trunk" })])
      ) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toEqual({
      ok: true,
      repos: [
        {
          full_name: "bensigo/agentrail",
          private: false,
          default_branch: "trunk",
          html_url: "https://github.com/bensigo/agentrail",
        },
      ],
    });
  });

  it("paginates with per_page=100 and stops once a page returns fewer than 100 repos", async () => {
    const page1 = repoPage(100, "acme/p1");
    const page2 = repoPage(37, "acme/p2");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ghInstallationResponse(200, page1, { totalCount: 137 }))
      .mockResolvedValueOnce(ghInstallationResponse(200, page2, { totalCount: 137 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("per_page=100");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("page=1");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("page=2");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos).toHaveLength(137);
  });

  it("stops after a single page when the first page is already short (no wasted second call)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, repoPage(3)));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repos).toHaveLength(3);
  });

  it("filters by q (case-insensitive substring over full_name) after aggregating all pages", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        ghInstallationResponse(200, [repo("bensigo/agentrail"), repo("acme/Website")])
      ) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok", { q: "web" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0]!.full_name).toBe("acme/Website");
    }
  });

  it("401 → kind: reconnect (installation token rejected)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(401, [])) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toMatchObject({ ok: false, kind: "reconnect", status: 401 });
  });

  it("403 with x-ratelimit-remaining: 0 → kind: rate_limited", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        ghInstallationResponse(403, [], { rateRemaining: "0" })
      ) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toMatchObject({ ok: false, kind: "rate_limited", status: 429 });
  });

  it("403 without rate-limit headers → kind: reconnect", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(403, [])) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toMatchObject({ ok: false, kind: "reconnect", status: 403 });
  });

  it("network error → kind: error, 502", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toMatchObject({ ok: false, kind: "error", status: 502 });
  });

  it("unmapped non-2xx → kind: error, 502", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(500, [])) as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(result).toMatchObject({ ok: false, kind: "error", status: 502 });
  });

  it("a later page's failure aborts pagination with that failure (no silent partial result)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ghInstallationResponse(200, repoPage(100), { totalCount: 200 }))
      .mockResolvedValueOnce(ghInstallationResponse(401, []));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await listInstallationRepos("tok");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, kind: "reconnect" });
  });
});

describe("checkRepoAccess", () => {
  it("ok: true when the repo is in the installation's repository list", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        ghInstallationResponse(200, [repo("bensigo/agentrail"), repo("acme/website")])
      ) as unknown as typeof fetch;

    const result = await checkRepoAccess("tok", "bensigo", "agentrail");

    expect(result).toEqual({ ok: true });
  });

  it("is case-insensitive on owner/repo", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, [repo("Bensigo/AgentRail")])) as unknown as typeof fetch;

    const result = await checkRepoAccess("tok", "bensigo", "agentrail");

    expect(result).toEqual({ ok: true });
  });

  it("kind: not_found when the repo is absent from the installation's list (never a per-repo GET)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(ghInstallationResponse(200, [repo("acme/website")]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkRepoAccess("tok", "bensigo", "agentrail");

    expect(result).toEqual({ ok: false, kind: "not_found" });
    // No per-repo permissions probe — every call is the one list fetch.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain("/repos/bensigo/agentrail");
    }
  });

  it("kind: indeterminate when the installation list call fails (network/rate/reconnect) — never blocks on a hiccup", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;

    const result = await checkRepoAccess("tok", "bensigo", "agentrail");

    expect(result).toEqual({ ok: false, kind: "indeterminate" });
  });
});
