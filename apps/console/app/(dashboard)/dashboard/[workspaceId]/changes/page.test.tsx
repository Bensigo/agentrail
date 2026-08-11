import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  readAcceptanceRecordSummaries: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("../components/acceptance-record-summary-list", async (importOriginal) => {
  const original = await importOriginal<typeof import("../components/acceptance-record-summary-list")>();
  return {
    ...original,
    AcceptanceRecordSummaryList: vi.fn(() => null),
  };
});

import { readAcceptanceRecordSummaries } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { EmptyState } from "../../../../components/empty-state";
import {
  AcceptanceRecordSummaryList,
} from "../components/acceptance-record-summary-list";
import ChangesPage from "./page";

type ElementLike = {
  type?: unknown;
  props?: Record<string, unknown>;
};

function findByType(node: unknown, type: unknown): ElementLike[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findByType(child, type));
  const element = node as ElementLike;
  const own = element.type === type ? [element] : [];
  return [...own, ...findByType(element.props?.children, type)];
}

const workspaceId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const summary = {
  recordId: "00000000-0000-4000-8000-000000000010",
  workspaceId,
  repo: "ada/widgets",
  issueNumber: 41,
  createdAt: new Date("2026-08-10T09:00:00.000Z"),
  updatedAt: new Date("2026-08-10T10:00:00.000Z"),
  requestedWork: { kind: "unknown" as const },
  suppliedContext: { kind: "unknown" as const },
  pullRequest: { kind: "not_attached" as const },
  proof: { kind: "unknown" as const },
  unknownReasons: ["requested_work_not_confirmed" as const],
  neededDecision: { kind: "unknown" as const },
  outcome: { kind: "not_recorded" as const },
};

async function render(repo?: string | string[]) {
  return ChangesPage({
    params: Promise.resolve({ workspaceId }),
    searchParams: Promise.resolve(repo === undefined ? {} : { repo }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: userId } } as never);
  vi.mocked(getMembership).mockResolvedValue({ role: "member" } as never);
  vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
    kind: "records",
    records: [summary],
  } as never);
});

describe("ChangesPage", () => {
  it("uses the member-scoped server summary projection and the shared seven-question renderer", async () => {
    const rendered = await render("  ada/widgets  ");

    expect(readAcceptanceRecordSummaries).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      repo: "ada/widgets",
    });
    const lists = findByType(rendered, AcceptanceRecordSummaryList);
    expect(lists).toHaveLength(1);
    expect(lists[0]?.props?.workspaceId).toBe(workspaceId);
    expect(lists[0]?.props?.records).toEqual([summary]);
    expect(lists[0]?.props?.compact).toBeUndefined();
  });

  it("fails a malformed repo filter closed without reading any Records", async () => {
    const rendered = await render("../widgets");

    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
    const emptyStates = findByType(rendered, EmptyState);
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.props?.title).toBe("Invalid repository filter");
    expect(emptyStates[0]?.props?.description).toContain("No Acceptance Records were read");
  });

  it("fails repeated repo filters closed without reading any Records", async () => {
    await render(["ada/widgets", "ada/other"]);

    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("does not read workspace summaries without membership", async () => {
    vi.mocked(getMembership).mockResolvedValue(null as never);

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("keeps an honest empty state when the server projection is empty", async () => {
    vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
      kind: "records",
      records: [],
    } as never);

    const rendered = await render();
    const emptyStates = findByType(rendered, EmptyState);
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.props?.title).toBe("No change records yet");
  });
});
