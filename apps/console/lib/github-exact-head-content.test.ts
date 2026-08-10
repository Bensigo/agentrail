import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { acceptanceContextOverlayManifestSha256 } from "@agentrail/db-postgres";
import {
  MAX_EXACT_HEAD_TREE_RESPONSE_BYTES,
  materializeExactHeadGithubContent,
} from "./github-exact-head-content";
import type { ExactHeadGithubContextSnapshot } from "./github-exact-head-context";

const TOKEN = "ghs_installation-token-secret";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const SOURCE = "export const answer = 42;\n";
const BLOB = "64a32fd291e405a963aacf964a021809dd206c46";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(overrides: Partial<ExactHeadGithubContextSnapshot> = {}): ExactHeadGithubContextSnapshot {
  const value: ExactHeadGithubContextSnapshot = {
    repo: "bensigo/agentrail",
    prNumber: 82,
    baseSha: BASE,
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    headTreeSha: TREE,
    changedFiles: [{ path: "apps/console/lib/widget.ts", status: "modified", blobSha: BLOB, previousPath: null }],
    manifestSha256: "",
    provenance: {
      schemaVersion: 1,
      included: [{ path: "apps/console/lib/widget.ts", source: "overlay", reason: "exact_base_to_head_compare" }],
      excluded: [],
    },
    ...overrides,
  };
  return {
    ...value,
    manifestSha256: overrides.manifestSha256 ?? acceptanceContextOverlayManifestSha256({
      schemaVersion: 1,
      baseSha: value.baseSha,
      mergeBaseSha: value.mergeBaseSha,
      headSha: value.headSha,
      files: value.changedFiles
        .map((file) => ({ ...file, status: file.status as "added" | "modified" | "removed" | "renamed" | "copied" | "changed" })),
    }),
  };
}

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function blobResponse(content: string, sha = gitBlobSha(content)): Response {
  return json(200, { sha, size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") });
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
});

describe("materializeExactHeadGithubContent", () => {
  it("materializes the exact changed blob from the verified immutable head tree, then exposes a path-only fallback reader", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, {
        sha: TREE,
        truncated: false,
        tree: [{ path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length }],
      }))
      .mockResolvedValueOnce(json(200, { sha: BLOB, size: SOURCE.length, encoding: "base64", content: Buffer.from(SOURCE).toString("base64") }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });

    expect(result).toMatchObject({
      ok: true,
      materialization: {
        content: {
          headTreeSha: TREE,
          records: [{
          path: "apps/console/lib/widget.ts",
          blobSha: BLOB,
          contentSha256: createHash("sha256").update(Buffer.from(SOURCE)).digest("hex"),
          byteCount: SOURCE.length,
          lineCount: 2,
          content: SOURCE,
          source: "exact_head_overlay",
          reason: "exact_base_to_head_compare",
          }],
          exclusions: [],
        },
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.github.com/repos/bensigo/agentrail/git/trees/${TREE}?recursive=1`,
      expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.github.com/repos/bensigo/agentrail/git/blobs/${BLOB}`,
      expect.objectContaining({ redirect: "error" })
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url)).join("\n")).not.toMatch(/contents\/|search\/code|ref=|archive|clone/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    if (!result.ok) throw new Error("expected exact-head materialization");
    const fallback = await result.materialization.readExactPath("apps/console/lib/widget.ts");
    expect(fallback).toMatchObject({ ok: true, record: { path: "apps/console/lib/widget.ts", blobSha: BLOB, content: SOURCE } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing/truncated or collision-prone recursive tree before any blob can become source", async () => {
    const changed = { path: "src/A.ts", status: "modified", blobSha: BLOB, previousPath: null } as const;
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, {
      sha: TREE,
      // `truncated` omitted is deliberately not treated as false.
      tree: [
        { path: "src/A.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length },
        { path: "src/a.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length },
      ],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: [changed] }) }))
      .resolves.toMatchObject({ ok: false, reason: "invalid_tree" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds an untruncated recursive tree above the local entry cap", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, {
      sha: TREE,
      truncated: false,
      tree: Array.from({ length: 10_001 }, (_, index) => ({
        path: `src/${index}.ts`, mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length,
      })),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() }))
      .resolves.toMatchObject({ ok: false, reason: "tree_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds declared and streamed response bodies before any blob can become source", async () => {
    const rawBody = `upstream body must not leak ${TOKEN}`;
    const declaredFetch = vi.fn().mockResolvedValueOnce(new Response(rawBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_EXACT_HEAD_TREE_RESPONSE_BYTES + 1),
      },
    }));
    global.fetch = declaredFetch as unknown as typeof fetch;

    const declared = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    expect(declared).toEqual({ ok: false, kind: "not_proven", reason: "invalid_tree", exclusions: [] });
    expect(declaredFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(declared)).not.toContain(rawBody);
    expect(JSON.stringify(declared)).not.toContain(TOKEN);

    const cancel = vi.fn();
    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_EXACT_HEAD_TREE_RESPONSE_BYTES + 1));
      },
      cancel,
    });
    const streamedFetch = vi.fn().mockResolvedValueOnce(new Response(streamedBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    global.fetch = streamedFetch as unknown as typeof fetch;

    const streamed = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    expect(streamed).toEqual({ ok: false, kind: "not_proven", reason: "invalid_tree", exclusions: [] });
    expect(streamedFetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(streamed)).not.toContain(TOKEN);
  });

  it("aborts both a stalled fetch and a stalled response body at the fixed timeout", async () => {
    vi.useFakeTimers();
    const stalledFetch = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error(`stalled fetch ${TOKEN}`)));
      })
    );
    global.fetch = stalledFetch as unknown as typeof fetch;

    const fetchPending = materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    await vi.advanceTimersByTimeAsync(8_000);
    const fetchResult = await fetchPending;
    expect(fetchResult).toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable", exclusions: [] });
    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchResult)).not.toContain(TOKEN);

    const stalledBodyFetch = vi.fn((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            controller.error(new Error(`stalled body ${TOKEN}`));
          });
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    global.fetch = stalledBodyFetch as unknown as typeof fetch;

    const bodyPending = materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    await vi.advanceTimersByTimeAsync(8_000);
    const bodyResult = await bodyPending;
    expect(bodyResult).toEqual({ ok: false, kind: "not_proven", reason: "github_unavailable", exclusions: [] });
    expect(stalledBodyFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(bodyResult)).not.toContain(TOKEN);
  });

  it("rejects a mismatched tree identity and a forged admitted snapshot before source exposure", async () => {
    const treeFetch = vi.fn().mockResolvedValueOnce(json(200, {
      sha: "e".repeat(40), truncated: false,
      tree: [{ path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length }],
    }));
    global.fetch = treeFetch as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() }))
      .resolves.toMatchObject({ ok: false, reason: "invalid_tree" });

    const noFetch = vi.fn();
    global.fetch = noFetch as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ manifestSha256: "0".repeat(64) }) }))
      .resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("requires every current changed path to resolve to a regular exact blob and every removed path to be absent", async () => {
    const oldBlob = "f".repeat(40);
    const changed = [
      { path: "src/deleted.ts", status: "removed", blobSha: oldBlob, previousPath: null },
      { path: "src/link.ts", status: "modified", blobSha: BLOB, previousPath: null },
    ] as ExactHeadGithubContextSnapshot["changedFiles"];
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, {
      sha: TREE,
      truncated: false,
      tree: [
        { path: "src/link.ts", mode: "120000", type: "blob", sha: BLOB, size: SOURCE.length },
        { path: "src/deleted.ts", mode: "100644", type: "blob", sha: oldBlob, size: SOURCE.length },
      ],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: changed }) });
    expect(result).toMatchObject({ ok: false, reason: "invalid_tree", exclusions: [{ path: "src/deleted.ts", reason: "removed_at_exact_head" }] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a blob response claims the tree SHA but its decoded Git object bytes do not", async () => {
    const altered = "export const answer = 43;\n";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [{ path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length }] }))
      .mockResolvedValueOnce(json(200, { sha: BLOB, size: altered.length, encoding: "base64", content: Buffer.from(altered).toString("base64") }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() }))
      .resolves.toMatchObject({ ok: false, reason: "invalid_blob" });
  });

  it("accepts GitHub's canonical 60-column base64 plus final newline, and accepts a zero-byte blob", async () => {
    const wrappedContent = "export const long = '" + "x".repeat(100) + "';\n";
    const wrappedBlob = gitBlobSha(wrappedContent);
    const emptyBlob = gitBlobSha("");
    const encoded = Buffer.from(wrappedContent).toString("base64").match(/.{1,60}/g)!.join("\n") + "\n";
    const changed = [
      { path: "src/empty.ts", status: "added", blobSha: emptyBlob, previousPath: null },
      { path: "src/wrapped.ts", status: "modified", blobSha: wrappedBlob, previousPath: null },
    ] as ExactHeadGithubContextSnapshot["changedFiles"];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [
        { path: "src/empty.ts", mode: "100644", type: "blob", sha: emptyBlob, size: 0 },
        { path: "src/wrapped.ts", mode: "100644", type: "blob", sha: wrappedBlob, size: Buffer.byteLength(wrappedContent) },
      ] }))
      .mockResolvedValueOnce(json(200, { sha: emptyBlob, size: 0, encoding: "base64", content: "" }))
      .mockResolvedValueOnce(json(200, { sha: wrappedBlob, size: Buffer.byteLength(wrappedContent), encoding: "base64", content: encoded }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: changed }) });
    expect(result).toMatchObject({ ok: true, materialization: { content: { records: [{ path: "src/empty.ts", byteCount: 0, content: "" }, { path: "src/wrapped.ts", content: wrappedContent }] } } });
  });

  it.each([
    ["noncanonical base64", "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyOwo=!"],
    ["binary NUL", Buffer.from("hello\0world").toString("base64")],
  ])("holds %s blob content without returning it", async (_label, content) => {
    const bytes = Buffer.from(content, "base64");
    const sha = _label === "binary NUL" ? gitBlobSha("hello\0world") : BLOB;
    const size = _label === "binary NUL" ? bytes.length : SOURCE.length;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [{ path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha, size }] }))
      .mockResolvedValueOnce(json(200, { sha, size, encoding: "base64", content }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await materializeExactHeadGithubContent({
      token: TOKEN,
      snapshot: snapshot({ changedFiles: [{ path: "apps/console/lib/widget.ts", status: "modified", blobSha: sha, previousPath: null }] }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(_label === "binary NUL" ? "unsafe_content" : "invalid_blob");
    expect(JSON.stringify(result)).not.toContain("hello");
  });

  it("fails closed with bounded exclusion metadata for secret content or a secret-bearing path", async () => {
    const secretContent = 'const token = "ghp_123456789012345678901234";\n';
    const secretBlob = gitBlobSha(secretContent);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [{ path: "src/example.ts", mode: "100644", type: "blob", sha: secretBlob, size: Buffer.byteLength(secretContent) }] }))
      .mockResolvedValueOnce(blobResponse(secretContent, secretBlob));
    global.fetch = fetchMock as unknown as typeof fetch;

    const held = await materializeExactHeadGithubContent({
      token: TOKEN,
      snapshot: snapshot({ changedFiles: [{ path: "src/example.ts", status: "modified", blobSha: secretBlob, previousPath: null }] }),
    });
    expect(held).toEqual({
      ok: false,
      kind: "not_proven",
      reason: "unsafe_content",
      exclusions: [{
        path: "src/example.ts",
        source: "exact_head_overlay",
        blobSha: secretBlob,
        byteCount: Buffer.byteLength(secretContent),
        reason: "secret_content_policy",
        secretKinds: ["generic_assigned_secret", "github_token"],
        findingCount: 2,
      }],
    });
    expect(JSON.stringify(held)).not.toContain("ghp_123456789012345678901234");
    expect(JSON.stringify(held)).not.toContain("REDACTED_SECRET");
    expect(JSON.stringify(held)).not.toContain(TOKEN);

    global.fetch = vi.fn() as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({
      token: TOKEN,
      snapshot: snapshot({ changedFiles: [{ path: ".env.production", status: "added", blobSha: secretBlob, previousPath: null }] }),
    })).resolves.toEqual({
      ok: false,
      kind: "not_proven",
      reason: "unsafe_path",
      exclusions: [{
        path: ".env.production",
        source: "exact_head_overlay",
        blobSha: secretBlob,
        byteCount: null,
        reason: "secret_path_policy",
        secretKinds: [],
        findingCount: 0,
      }],
    });
    expect(global.fetch).not.toHaveBeenCalled();

    await expect(materializeExactHeadGithubContent({
      token: TOKEN,
      snapshot: snapshot({ changedFiles: [{ path: "src/example.ts", status: "renamed", blobSha: secretBlob, previousPath: "secrets/old.ts" }] }),
    })).resolves.toMatchObject({ ok: false, reason: "unsafe_path" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("preserves renamed provenance, explicitly excludes removed paths, and produces bytewise-stable content identity", async () => {
    const alpha = "export const alpha = 1;\n";
    const beta = "export const beta = 2;\n";
    const alphaBlob = gitBlobSha(alpha);
    const betaBlob = gitBlobSha(beta);
    const changed = [
      { path: "src/a.ts", status: "modified", blobSha: alphaBlob, previousPath: null },
      { path: "src/gone.ts", status: "removed", blobSha: BLOB, previousPath: null },
      { path: "src/z.ts", status: "renamed", blobSha: betaBlob, previousPath: "src/old-z.ts" },
    ] as ExactHeadGithubContextSnapshot["changedFiles"];
    const tree = { sha: TREE, truncated: false, tree: [
      { path: "src/a.ts", mode: "100644", type: "blob", sha: alphaBlob, size: Buffer.byteLength(alpha) },
      { path: "src/z.ts", mode: "100644", type: "blob", sha: betaBlob, size: Buffer.byteLength(beta) },
    ] };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, tree)).mockResolvedValueOnce(blobResponse(alpha, alphaBlob)).mockResolvedValueOnce(blobResponse(beta, betaBlob));
    global.fetch = fetchMock as unknown as typeof fetch;
    const first = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: changed }) });
    expect(first).toMatchObject({ ok: true, materialization: { content: {
      records: [{ path: "src/a.ts" }, { path: "src/z.ts", previousPath: "src/old-z.ts" }],
      exclusions: [{ path: "src/gone.ts", reason: "removed_at_exact_head" }],
    } } });

    const shuffledTree = { ...tree, tree: [...tree.tree].reverse() };
    const secondFetch = vi.fn().mockResolvedValueOnce(json(200, shuffledTree)).mockResolvedValueOnce(blobResponse(alpha, alphaBlob)).mockResolvedValueOnce(blobResponse(beta, betaBlob));
    global.fetch = secondFetch as unknown as typeof fetch;
    const second = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: changed }) });
    expect(second).toMatchObject({ ok: true });
    if (first.ok && second.ok) {
      expect(second.materialization.content).toEqual(first.materialization.content);
      expect(secondFetch.mock.calls.map(([url]) => String(url))).toEqual([
        `https://api.github.com/repos/bensigo/agentrail/git/trees/${TREE}?recursive=1`,
        `https://api.github.com/repos/bensigo/agentrail/git/blobs/${alphaBlob}`,
        `https://api.github.com/repos/bensigo/agentrail/git/blobs/${betaBlob}`,
      ]);
    }
  });

  it("resolves an exact tree path only after materialization, without any ref/contents/search request", async () => {
    const dependency = "export const dependency = true;\n";
    const dependencyBlob = gitBlobSha(dependency);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [
        { path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length },
        { path: "apps/console/lib/dependency.ts", mode: "100755", type: "blob", sha: dependencyBlob, size: Buffer.byteLength(dependency) },
      ] }))
      .mockResolvedValueOnce(blobResponse(SOURCE, BLOB))
      .mockResolvedValueOnce(blobResponse(dependency, dependencyBlob));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    if (!result.ok) throw new Error("expected exact-head materialization");
    await expect(result.materialization.readExactPath("../.env")).resolves.toMatchObject({ ok: false, reason: "unsafe_path" });
    await expect(result.materialization.readExactPath("apps/console/lib/missing.ts")).resolves.toEqual({ ok: false, kind: "not_proven", reason: "path_not_found" });
    await expect(result.materialization.readExactPath("apps/console/lib/dependency.ts")).resolves.toMatchObject({ ok: true, record: { source: "exact_head_tree_fallback", blobSha: dependencyBlob } });
    await expect(result.materialization.readExactPath("apps/console/lib/dependency.ts")).resolves.toMatchObject({ ok: true, record: { source: "exact_head_tree_fallback", blobSha: dependencyBlob } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).join("\n")).not.toMatch(/contents\/|search\/code|ref=|archive|clone/);
  });

  it("returns only policy exclusion metadata when direct exact-path fallback encounters secret path or content", async () => {
    const secretContent = "password=supersecretvalue\n";
    const secretBlob = gitBlobSha(secretContent);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [
        { path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length },
        { path: "src/dependency.ts", mode: "100644", type: "blob", sha: secretBlob, size: Buffer.byteLength(secretContent) },
        { path: ".env", mode: "100644", type: "blob", sha: secretBlob, size: Buffer.byteLength(secretContent) },
      ] }))
      .mockResolvedValueOnce(blobResponse(SOURCE, BLOB))
      .mockResolvedValueOnce(blobResponse(secretContent, secretBlob));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
    if (!result.ok) throw new Error("expected exact-head materialization");

    await expect(result.materialization.readExactPath(".env")).resolves.toEqual({
      ok: false,
      kind: "not_proven",
      reason: "unsafe_path",
      exclusion: {
        path: ".env", source: "exact_head_tree_fallback", blobSha: secretBlob, byteCount: null,
        reason: "secret_path_policy", secretKinds: [], findingCount: 0,
      },
    });
    const held = await result.materialization.readExactPath("src/dependency.ts");
    expect(held).toEqual({
      ok: false,
      kind: "not_proven",
      reason: "unsafe_content",
      exclusion: {
        path: "src/dependency.ts", source: "exact_head_tree_fallback", blobSha: secretBlob,
        byteCount: Buffer.byteLength(secretContent), reason: "secret_content_policy",
        secretKinds: ["generic_assigned_secret"], findingCount: 1,
      },
    });
    expect(JSON.stringify(held)).not.toContain("supersecretvalue");
    expect(JSON.stringify(held)).not.toContain("REDACTED_SECRET");
    expect(JSON.stringify(held)).not.toContain(TOKEN);
  });

  it.each([".npmrc", ".yarnrc", ".pypirc", ".netrc", ".git-credentials", ".docker/config.json"])(
    "denies common credential configuration paths without fetching or exposing their content: %s",
    async (path) => {
      const authContent = "_authToken=private-npm-token-value\n_auth=private-npm-auth-value\n";
      const authBlob = gitBlobSha(authContent);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json(200, { sha: TREE, truncated: false, tree: [
          { path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: SOURCE.length },
          { path, mode: "100644", type: "blob", sha: authBlob, size: Buffer.byteLength(authContent) },
        ] }))
        .mockResolvedValueOnce(blobResponse(SOURCE, BLOB));
      global.fetch = fetchMock as unknown as typeof fetch;
      const result = await materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() });
      if (!result.ok) throw new Error("expected exact-head materialization");

      const denied = await result.materialization.readExactPath(path);
      expect(denied).toEqual({
        ok: false, kind: "not_proven", reason: "unsafe_path",
        exclusion: { path, source: "exact_head_tree_fallback", blobSha: authBlob, byteCount: null, reason: "secret_path_policy", secretKinds: [], findingCount: 0 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(denied)).not.toContain("private-npm-token-value");
      expect(JSON.stringify(denied)).not.toContain("private-npm-auth-value");
    }
  );

  it("rejects malformed regular-file size while parsing the head tree, before a blob request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, {
      sha: TREE, truncated: false,
      tree: [{ path: "apps/console/lib/widget.ts", mode: "100644", type: "blob", sha: BLOB, size: "26" }],
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot() }))
      .resolves.toMatchObject({ ok: false, reason: "invalid_tree" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds before GitHub I/O when all-current-file or aggregate source bounds are exceeded", async () => {
    const tooMany = Array.from({ length: 129 }, (_, index) => ({
      path: `src/${String(index).padStart(3, "0")}.ts`, status: "modified", blobSha: BLOB, previousPath: null,
    })) as ExactHeadGithubContextSnapshot["changedFiles"];
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: tooMany }) }))
      .resolves.toMatchObject({ ok: false, reason: "content_limit" });
    expect(fetchMock).not.toHaveBeenCalled();

    const large = Array.from({ length: 5 }, (_, index) => ({
      path: `large/${String(index).padStart(3, "0")}.ts`, status: "modified", blobSha: `${index}`.repeat(40), previousPath: null,
    })) as ExactHeadGithubContextSnapshot["changedFiles"];
    const treeFetch = vi.fn().mockResolvedValueOnce(json(200, {
      sha: TREE, truncated: false, tree: large.map((file) => ({
        path: file.path, mode: "100644", type: "blob", sha: file.blobSha, size: 256 * 1024,
      })),
    }));
    global.fetch = treeFetch as unknown as typeof fetch;
    await expect(materializeExactHeadGithubContent({ token: TOKEN, snapshot: snapshot({ changedFiles: large }) }))
      .resolves.toMatchObject({ ok: false, reason: "content_limit" });
    expect(treeFetch).toHaveBeenCalledTimes(1);
  });
});
