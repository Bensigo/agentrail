import { describe, expect, it } from "vitest";
import Link from "next/link";
import { AcceptanceReviewList, reviewRequestLabel } from "./acceptance-review-list";

type ElementLike = { type: unknown; props: Record<string, unknown> };
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const RECORD_ID = "00000000-0000-0000-0000-000000000010";

function elementsOfType(node: unknown, type: unknown): ElementLike[] {
  if (node == null || typeof node !== "object") return [];
  const element = node as ElementLike;
  const own = element.type === type ? [element] : [];
  const children = element.props?.children;
  const nested = Array.isArray(children)
    ? children.flatMap((child) => elementsOfType(child, type))
    : elementsOfType(children, type);
  return [...own, ...nested];
}

const record = {
  recordId: RECORD_ID,
  workspaceId: WORKSPACE_ID,
  repo: "acme/widgets",
  issueNumber: 42,
  createdAt: new Date("2026-08-13T10:00:00.000Z"),
  updatedAt: new Date("2026-08-13T11:00:00.000Z"),
  requestedWork: {
    kind: "confirmed",
    originalRequest: "Keep the checkout total exact",
    acceptanceContract: { id: "contract-1", version: 1, sha256: "a".repeat(64) },
  },
  suppliedContext: {
    kind: "compiled",
    sourceSnapshot: {
      id: "snapshot-1",
      headSha: "b".repeat(40),
      headCycleId: "cycle-1",
      compilerVersion: "v1",
      packetSetSha256: "c".repeat(64),
    },
    compiledPack: {
      id: "pack-1",
      sha256: "d".repeat(64),
      sourceCustodyIdentitySha256: "e".repeat(64),
      compilerVersion: "v1",
      policyVersion: "p1",
    },
  },
  pullRequest: {
    kind: "attached",
    prNumber: 98,
    head: {
      kind: "current",
      sha: "f".repeat(40),
      headCycleId: "cycle-1",
      authorityGeneration: 1,
    },
  },
  proof: {
    kind: "recorded",
    reviewJobId: "job-1",
    verdict: "failed",
    postedReviewUrl: "https://github.com/acme/widgets/pull/98#pullrequestreview-1",
    postedAttestationEventId: "event-1",
  },
  unknownReasons: [],
  neededDecision: { kind: "required", choices: ["changes_requested", "rejected"] },
  outcome: { kind: "not_recorded" },
} as const;

describe("AcceptanceReviewList", () => {
  it("links a human-readable review card to the approval detail surface", () => {
    const list = AcceptanceReviewList({ records: [record] as never, workspaceId: WORKSPACE_ID });
    const links = elementsOfType(list, Link);

    expect(reviewRequestLabel(record as never)).toBe("Keep the checkout total exact");
    expect(links).toHaveLength(1);
    expect(links[0]?.props).toMatchObject({
      href: `/dashboard/${WORKSPACE_ID}/changes/${RECORD_ID}`,
      "aria-label": "Review acme/widgets PR #98",
      children: "Review",
    });
  });

  it("has no inline approve, hold, or reject controls", () => {
    const source = AcceptanceReviewList.toString();
    expect(source).not.toMatch(/onDecide|Approve|Hold|Reject/u);
  });
});
