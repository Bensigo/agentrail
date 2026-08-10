import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { acceptanceContextOverlayManifestSha256 } from "@agentrail/db-postgres";
import {
  MAX_EXACT_HEAD_COMMIT_RESPONSE_BYTES,
  MAX_EXACT_HEAD_COMPARE_RESPONSE_BYTES,
  MAX_EXACT_HEAD_PR_RESPONSE_BYTES,
  readExactHeadGithubContext,
} from "./github-exact-head-context";

const TOKEN = "ghs_installation-token-secret";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const BLOB = "d".repeat(40);
const MERGE_BASE = "e".repeat(40);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("readExactHeadGithubContext", () => {
  it("reads PR metadata, head commit, then immutable base...head compare and returns a token-free manifest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(
        json(200, {
          base_commit: { sha: BASE },
          merge_base_commit: { sha: MERGE_BASE },
          files: [
            { filename: "apps/console/lib/widget.ts", status: "modified", sha: BLOB },
            {
              filename: "apps/console/lib/renamed.ts",
              previous_filename: "apps/console/lib/old-name.ts",
              status: "renamed",
              sha: BLOB,
            },
            { filename: "apps/console/lib/removed.ts", status: "removed" },
          ],
        })
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({
      ok: true,
      snapshot: {
        repo: "bensigo/agentrail",
        prNumber: 82,
        baseSha: BASE,
        mergeBaseSha: MERGE_BASE,
        headSha: HEAD,
        headTreeSha: TREE,
        changedFiles: [
          {
            path: "apps/console/lib/removed.ts",
            status: "removed",
            blobSha: null,
            previousPath: null,
            headRanges: null,
            patchSha256: null,
          },
          {
            path: "apps/console/lib/renamed.ts",
            status: "renamed",
            blobSha: BLOB,
            previousPath: "apps/console/lib/old-name.ts",
            headRanges: null,
            patchSha256: null,
          },
          {
            path: "apps/console/lib/widget.ts",
            status: "modified",
            blobSha: BLOB,
            previousPath: null,
            headRanges: null,
            patchSha256: null,
          },
        ],
        manifestSha256: acceptanceContextOverlayManifestSha256({
          schemaVersion: 1,
          baseSha: BASE,
          mergeBaseSha: MERGE_BASE,
          headSha: HEAD,
          files: [
            {
              path: "apps/console/lib/removed.ts",
              status: "removed",
              blobSha: null,
              previousPath: null,
            },
            {
              path: "apps/console/lib/renamed.ts",
              status: "renamed",
              blobSha: BLOB,
              previousPath: "apps/console/lib/old-name.ts",
            },
            {
              path: "apps/console/lib/widget.ts",
              status: "modified",
              blobSha: BLOB,
              previousPath: null,
            },
          ],
        }),
        provenance: {
          schemaVersion: 1,
          included: [
            { path: "apps/console/lib/removed.ts", source: "overlay", reason: "exact_base_to_head_compare" },
            { path: "apps/console/lib/renamed.ts", source: "overlay", reason: "exact_base_to_head_compare" },
            { path: "apps/console/lib/widget.ts", source: "overlay", reason: "exact_base_to_head_compare" },
          ],
          excluded: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/bensigo/agentrail/pulls/82",
      expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/bensigo/agentrail/git/commits/${HEAD}`,
      expect.objectContaining({ redirect: "error" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `https://api.github.com/repos/bensigo/agentrail/compare/${BASE}...${HEAD}`,
      expect.objectContaining({ redirect: "error" })
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url)).join("\n")).not.toMatch(/search\/code|contents\/|ref=/);
  });

  it("holds before the commit and compare reads when GitHub's current head differs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {
      head: { sha: "e".repeat(40) },
      base: { sha: BASE },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "head_mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("does not manufacture a partial overlay when GitHub's compare file list reaches its 300-file ceiling", async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: "modified",
      sha: BLOB,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        files,
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("holds an empty compare until an exact-head direct fallback can supply correction context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        files: [],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it("holds when compare returns an unsafe traversal path instead of exposing it as a source candidate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        files: [{ filename: "apps/console/../secrets.ts", status: "modified", sha: BLOB }],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it.each(["./agentrail", "../agentrail", "bensigo/.."])(
    "rejects a repository with a dot segment before any GitHub request: %s",
    async (repo) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(readExactHeadGithubContext({
        token: TOKEN,
        repo,
        prNumber: 82,
        expectedHeadSha: HEAD,
      })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "invalid_input" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("converts a GitHub transport failure into token-free not_proven evidence", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error(`network leaked ${TOKEN}`)) as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("holds on a rejected or malformed upstream response without surfacing its body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(503, { message: `upstream body must not leak ${TOKEN}` })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "github_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("requires the compare response to attest both the requested base and its distinct merge base", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: "f".repeat(40) },
        merge_base_commit: { sha: MERGE_BASE },
        files: [],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it("holds on a truncated compare response instead of claiming an incomplete overlay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        truncated: true,
        files: [],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it("aborts a stalled fixed-host request and keeps the failure token-free", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })
    ) as unknown as typeof fetch;

    const pending = readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });
    await vi.advanceTimersByTimeAsync(8000);

    const result = await pending;
    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it.each([
    ["PR", MAX_EXACT_HEAD_PR_RESPONSE_BYTES, "invalid_pr_metadata", 1],
    ["commit", MAX_EXACT_HEAD_COMMIT_RESPONSE_BYTES, "invalid_head_commit", 2],
    ["compare", MAX_EXACT_HEAD_COMPARE_RESPONSE_BYTES, "invalid_compare_manifest", 3],
  ])("bounds declared %s response bodies without surfacing their content", async (_label, cap, reason, calls) => {
    const oversized = new Response(`upstream body must not leak ${TOKEN}`, {
      status: 200,
      headers: { "content-length": String(cap + 1) },
    });
    const responses = [
      json(200, { head: { sha: HEAD }, base: { sha: BASE } }),
      json(200, { sha: HEAD, tree: { sha: TREE } }),
      json(200, { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE }, files: [{ filename: "src/a.ts", status: "modified", sha: BLOB }] }),
    ];
    responses[calls - 1] = oversized;
    global.fetch = vi.fn()
      .mockResolvedValueOnce(responses[0]!)
      .mockResolvedValueOnce(responses[1]!)
      .mockResolvedValueOnce(responses[2]!) as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD });
    expect(result).toEqual({ ok: false, kind: "not_proven", reason });
    expect(global.fetch).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("aborts a stalled response body under the same timeout", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof fetch;
    const pending = readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable" });
  });

  it("rejects malformed PR metadata before any immutable-object request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not JSON", { status: 200, headers: { "content-type": "application/json" } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_pr_metadata" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-removed changed path that has no exact blob identity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        files: [{ filename: "src/no-blob.ts", status: "modified" }],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    });

    expect(result).toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it.each([
    ["a control character in a changed path", { filename: "src/line\nbreak.ts", status: "modified", sha: BLOB }],
    ["a rename without previous_filename", { filename: "src/new.ts", status: "renamed", sha: BLOB }],
    ["a rename whose previous_filename is unchanged", { filename: "src/same.ts", previous_filename: "src/same.ts", status: "renamed", sha: BLOB }],
    ["previous_filename on a non-rename", { filename: "src/current.ts", previous_filename: "src/old.ts", status: "modified", sha: BLOB }],
    ["an unsupported unchanged status", { filename: "src/current.ts", status: "unchanged", sha: BLOB }],
  ])("holds on %s", async (_label, changedFile) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { head: { sha: HEAD }, base: { sha: BASE } }))
      .mockResolvedValueOnce(json(200, { sha: HEAD, tree: { sha: TREE } }))
      .mockResolvedValueOnce(json(200, {
        base_commit: { sha: BASE },
        merge_base_commit: { sha: MERGE_BASE },
        files: [changedFile],
      }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(readExactHeadGithubContext({
      token: TOKEN,
      repo: "bensigo/agentrail",
      prNumber: 82,
      expectedHeadSha: HEAD,
    })).resolves.toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });

  it("derives the same manifest digest when GitHub returns the same exact files in a different order", async () => {
    const changed = [
      { filename: "src/z.ts", status: "modified", sha: BLOB },
      { filename: "src/a.ts", status: "added", sha: BLOB },
    ];
    const exactResponses = (files: unknown[]) => [
      json(200, { head: { sha: HEAD }, base: { sha: BASE } }),
      json(200, { sha: HEAD, tree: { sha: TREE } }),
      json(200, { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE }, files }),
    ];
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(exactResponses(changed)[0])
      .mockResolvedValueOnce(exactResponses(changed)[1])
      .mockResolvedValueOnce(exactResponses(changed)[2])
      .mockResolvedValueOnce(exactResponses([...changed].reverse())[0])
      .mockResolvedValueOnce(exactResponses([...changed].reverse())[1])
      .mockResolvedValueOnce(exactResponses([...changed].reverse())[2]) as unknown as typeof fetch;

    const first = await readExactHeadGithubContext({
      token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD,
    });
    const second = await readExactHeadGithubContext({
      token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD,
    });

    expect(first.ok && second.ok && first.snapshot.manifestSha256).toBe(
      second.ok ? second.snapshot.manifestSha256 : "not-a-snapshot"
    );
  });

  it("normalizes HEAD-side patch ranges, hashes raw patches, and leaves the v1 manifest unchanged", async () => {
    const patch = [
      "@@ -2,2 +2,3 @@ export const value = 1;",
      " line two",
      "+line three",
      "@@ -20 +22,2 @@ export const other = 1;",
      "+line twenty-two",
    ].join("\n");
    const changed = [{ filename: "src/widget.ts", status: "modified", sha: BLOB, patch }];
    const exactResponses = (files: unknown[]) => [
      json(200, { head: { sha: HEAD }, base: { sha: BASE } }),
      json(200, { sha: HEAD, tree: { sha: TREE } }),
      json(200, { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE }, files }),
    ];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(exactResponses(changed)[0]).mockResolvedValueOnce(exactResponses(changed)[1]).mockResolvedValueOnce(exactResponses(changed)[2])
      .mockResolvedValueOnce(exactResponses(changed)[0]).mockResolvedValueOnce(exactResponses(changed)[1]).mockResolvedValueOnce(exactResponses(changed)[2]) as unknown as typeof fetch;
    const first = await readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD });
    const second = await readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD });

    if (!first.ok || !second.ok) throw new Error("expected exact context snapshots");
    expect(first.snapshot.changedFiles[0]).toEqual({
      path: "src/widget.ts", status: "modified", blobSha: BLOB, previousPath: null,
      headRanges: [{ startLine: 2, endLine: 4 }, { startLine: 22, endLine: 23 }],
      patchSha256: createHash("sha256").update(patch, "utf8").digest("hex"),
    });
    expect(second.snapshot.changedFiles).toEqual(first.snapshot.changedFiles);
    expect(first.snapshot.manifestSha256).toBe(acceptanceContextOverlayManifestSha256({
      schemaVersion: 1, baseSha: BASE, mergeBaseSha: MERGE_BASE, headSha: HEAD,
      files: [{ path: "src/widget.ts", status: "modified", blobSha: BLOB, previousPath: null }],
    }));
  });

  it("keeps a missing patch explicit and rejects malformed hunk syntax", async () => {
    const responses = [
      json(200, { head: { sha: HEAD }, base: { sha: BASE } }),
      json(200, { sha: HEAD, tree: { sha: TREE } }),
      json(200, { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE }, files: [{ filename: "src/no-patch.ts", status: "modified", sha: BLOB }] }),
      json(200, { head: { sha: HEAD }, base: { sha: BASE } }),
      json(200, { sha: HEAD, tree: { sha: TREE } }),
      json(200, { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE }, files: [{ filename: "src/bad-patch.ts", status: "modified", sha: BLOB, patch: "@@ -nope +1 @@" }] }),
    ];
    global.fetch = vi.fn();
    for (const response of responses) vi.mocked(global.fetch).mockResolvedValueOnce(response);
    const missing = await readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD });
    expect(missing).toMatchObject({ ok: true, snapshot: { changedFiles: [{ headRanges: null, patchSha256: null }] } });
    await expect(readExactHeadGithubContext({ token: TOKEN, repo: "bensigo/agentrail", prNumber: 82, expectedHeadSha: HEAD }))
      .resolves.toEqual({ ok: false, kind: "not_proven", reason: "invalid_compare_manifest" });
  });
});
