import { describe, it, expect } from "vitest";
import {
  buildTree,
  deriveUnitPath,
  buildWikiNavTree,
  deriveFileRoster,
  buildFileRosterTree,
} from "./wiki-tree";
import type { WikiPageDTO } from "./wiki-format";

function page(overrides: Partial<WikiPageDTO> = {}): WikiPageDTO {
  return {
    slug: "wiki/unit/x",
    title: "X",
    kind: "unit",
    bodyMd: "body",
    citations: [],
    links: { related: [], dependsOn: [], dependedOnBy: [] },
    commitSha: "129103aa",
    model: "claude-haiku-4-5",
    generatedAt: "2026-07-23T14:00:00.000Z",
    stale: false,
    skeleton: {},
    ...overrides,
  };
}

describe("buildTree", () => {
  it("builds a single-branch nested tree from one path", () => {
    const tree = buildTree([{ path: "a/b/c", value: "leaf" }]);
    expect(tree).toEqual([
      {
        name: "a",
        path: "a",
        children: [
          {
            name: "b",
            path: "a/b",
            children: [{ name: "c", path: "a/b/c", children: [], value: "leaf" }],
          },
        ],
      },
    ]);
  });

  it("merges two paths that share a prefix into one directory node", () => {
    const tree = buildTree([
      { path: "apps/console", value: "console" },
      { path: "apps/jace", value: "jace" },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("apps");
    expect(tree[0]!.children.map((c) => c.name)).toEqual(["console", "jace"]);
    expect(tree[0]!.value).toBeUndefined(); // "apps" itself is never a leaf here
  });

  it("a value at an intermediate path is set on that exact node, not lost", () => {
    const tree = buildTree([
      { path: "a", value: "a-value" },
      { path: "a/b", value: "b-value" },
    ]);
    expect(tree[0]!.value).toBe("a-value");
    expect(tree[0]!.children[0]!.value).toBe("b-value");
  });

  it("skips an item with an empty/whitespace-only path — never guesses one", () => {
    const tree = buildTree([
      { path: "", value: "dropped" },
      { path: "   ", value: "also dropped" },
      { path: "real/path", value: "kept" },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("real");
  });

  it("preserves insertion order at each level", () => {
    const tree = buildTree([
      { path: "z", value: 1 },
      { path: "a", value: 2 },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["z", "a"]);
  });
});

describe("deriveUnitPath", () => {
  it("reads skeleton.path when present", () => {
    expect(deriveUnitPath(page({ skeleton: { path: "agentrail/context" } }))).toBe(
      "agentrail/context"
    );
  });

  it("trims leading/trailing slashes", () => {
    expect(deriveUnitPath(page({ skeleton: { path: "/agentrail/context/" } }))).toBe(
      "agentrail/context"
    );
  });

  it("returns null when skeleton has no path field — the pre-compiler reality today", () => {
    expect(deriveUnitPath(page({ skeleton: { fileCount: 31 } }))).toBeNull();
  });

  it("returns null when path is not a string (never crashes on unexpected compiler output)", () => {
    expect(deriveUnitPath(page({ skeleton: { path: 42 } }))).toBeNull();
    expect(deriveUnitPath(page({ skeleton: { path: null } }))).toBeNull();
  });

  it("returns null for an empty/whitespace path", () => {
    expect(deriveUnitPath(page({ skeleton: { path: "   " } }))).toBeNull();
  });

  it("never reads the slug or bodyMd to derive a path", () => {
    // A slug shaped like it COULD dash-decode into a path must NOT be parsed.
    const p = page({ slug: "wiki/unit/agentrail-context", skeleton: {}, bodyMd: "agentrail/context" });
    expect(deriveUnitPath(p)).toBeNull();
  });
});

describe("buildWikiNavTree", () => {
  it("groups units with path data into a tree, and separates pathless units into flat", () => {
    const withPath = page({
      slug: "wiki/unit/agentrail-context",
      title: "agentrail/context",
      skeleton: { path: "agentrail/context" },
    });
    const withoutPath = page({ slug: "wiki/unit/loose", title: "Loose unit", skeleton: {} });

    const result = buildWikiNavTree([withPath, withoutPath]);

    expect(result.flat).toEqual([withoutPath]);
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.name).toBe("agentrail");
    expect(result.tree[0]!.children[0]!.name).toBe("context");
    expect(result.tree[0]!.children[0]!.value).toEqual(withPath);
  });

  it("today's reality (compiler not shipped): every unit lacks path data -> tree is empty, flat has everything, same as the pre-hierarchy behavior", () => {
    const units = [
      page({ slug: "wiki/unit/a", skeleton: {} }),
      page({ slug: "wiki/unit/b", skeleton: {} }),
    ];
    const result = buildWikiNavTree(units);
    expect(result.tree).toEqual([]);
    expect(result.flat).toEqual(units);
  });

  it("groups multiple units under the same parent directory", () => {
    const a = page({ slug: "wiki/unit/db-postgres", skeleton: { path: "packages/db-postgres" } });
    const b = page({ slug: "wiki/unit/db-clickhouse", skeleton: { path: "packages/db-clickhouse" } });
    const result = buildWikiNavTree([a, b]);
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.name).toBe("packages");
    expect(result.tree[0]!.children.map((c) => c.name)).toEqual(["db-postgres", "db-clickhouse"]);
  });
});

describe("deriveFileRoster", () => {
  it("reads a plain string array", () => {
    const p = page({ skeleton: { files: ["a.py", "b.py"] } });
    expect(deriveFileRoster(p)).toEqual(["a.py", "b.py"]);
  });

  it("reads an array of {path} objects", () => {
    const p = page({ skeleton: { files: [{ path: "a.py" }, { path: "b.py" }] } });
    expect(deriveFileRoster(p)).toEqual(["a.py", "b.py"]);
  });

  it("returns null when files is absent", () => {
    expect(deriveFileRoster(page({ skeleton: {} }))).toBeNull();
  });

  it("returns null when files is not an array", () => {
    expect(deriveFileRoster(page({ skeleton: { files: "not-an-array" } }))).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(deriveFileRoster(page({ skeleton: { files: [] } }))).toBeNull();
  });

  it("drops malformed entries but keeps the well-formed ones", () => {
    const p = page({ skeleton: { files: ["a.py", 42, null, { path: "b.py" }, {}] } });
    expect(deriveFileRoster(p)).toEqual(["a.py", "b.py"]);
  });
});

describe("buildFileRosterTree", () => {
  it("builds a directory tree from a file roster", () => {
    const p = page({
      skeleton: { files: ["agentrail/context/index.py", "agentrail/context/packs.py"] },
    });
    const tree = buildFileRosterTree(p);
    expect(tree).not.toBeNull();
    expect(tree![0]!.name).toBe("agentrail");
    expect(tree![0]!.children[0]!.name).toBe("context");
    expect(tree![0]!.children[0]!.children.map((c) => c.name)).toEqual([
      "index.py",
      "packs.py",
    ]);
  });

  it("returns null (omit the block) when the page has no roster", () => {
    expect(buildFileRosterTree(page({ skeleton: {} }))).toBeNull();
  });
});
