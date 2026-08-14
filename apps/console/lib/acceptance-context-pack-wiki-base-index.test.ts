import { describe, expect, it } from "vitest";
import { buildAcceptanceContextPackWikiBaseIndex } from "./acceptance-context-pack-wiki-base-index";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "00000000-0000-4000-8000-000000000002";

function page(input: { id: string; slug: string; bodyMd: string; commit: string }) {
  return {
    id: input.id,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    slug: input.slug,
    bodyMd: input.bodyMd,
    commitSha: input.commit,
    inputsHash: "A".repeat(64),
    stale: false,
  };
}

describe("buildAcceptanceContextPackWikiBaseIndex", () => {
  it("mints one canonical identity independent of database return order", () => {
    const alpha = page({
      id: "00000000-0000-4000-8000-000000000011",
      slug: "guide/alpha.md",
      bodyMd: "# Alpha",
      commit: "B".repeat(40),
    });
    const beta = page({
      id: "00000000-0000-4000-8000-000000000012",
      slug: "guide/beta.md",
      bodyMd: "# Beta",
      commit: "C".repeat(40),
    });

    const forward = buildAcceptanceContextPackWikiBaseIndex({
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      pages: [alpha, beta] as never,
    });
    const reversed = buildAcceptanceContextPackWikiBaseIndex({
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      pages: [beta, alpha] as never,
    });

    expect(reversed).toEqual(forward);
    expect(forward.pages.map(({ slug }) => slug)).toEqual(["guide/alpha.md", "guide/beta.md"]);
    expect(forward.pages[0]).toMatchObject({
      commitSha: "b".repeat(40),
      inputsHashSha256: "a".repeat(64),
    });
    expect(forward.revisionSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses the page id as the stable tie-breaker for duplicate slugs", () => {
    const later = page({
      id: "00000000-0000-4000-8000-000000000022",
      slug: "guide/same.md",
      bodyMd: "# Later",
      commit: "D".repeat(40),
    });
    const earlier = page({
      id: "00000000-0000-4000-8000-000000000021",
      slug: "guide/same.md",
      bodyMd: "# Earlier",
      commit: "E".repeat(40),
    });

    const index = buildAcceptanceContextPackWikiBaseIndex({
      workspaceId: WORKSPACE_ID,
      repositoryId: REPOSITORY_ID,
      pages: [later, earlier] as never,
    });

    expect(index.pages.map(({ id }) => id)).toEqual([earlier.id, later.id]);
  });
});
