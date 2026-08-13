import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  pendingApprovalsForWorkspace: vi.fn(),
  readAcceptanceRecordSummaries: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
  useRouter: vi.fn(),
}));

import {
  pendingApprovalsForWorkspace,
  readAcceptanceRecordSummaries,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import ApprovalsPage from "./page";
import { AcceptanceReviewList } from "./components/acceptance-review-list";
import { PendingApprovalsList } from "./components/pending-approvals-list";
import { ParkedWorkList } from "./components/parked-work-list";
import { DeadLettersList } from "./components/dead-letters-list";

type ElementLike = { type: unknown; props: Record<string, unknown> };
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

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

const required = {
  recordId: "00000000-0000-0000-0000-000000000010",
  neededDecision: { kind: "required", choices: ["approved", "changes_requested", "rejected"] },
};
const recorded = {
  recordId: "00000000-0000-0000-0000-000000000011",
  neededDecision: {
    kind: "recorded",
    eventId: "00000000-0000-0000-0000-000000000012",
    decision: "approved",
    decidedAt: new Date(),
  },
};

describe("ApprovalsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getMembership).mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "owner",
      createdAt: new Date(),
    } as never);
    vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
      kind: "records",
      records: [required, recorded],
    } as never);
    vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([]);
  });

  it("centers decision-ready Acceptance Records in the workspace-scoped review list", async () => {
    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    const lists = elementsOfType(page, AcceptanceReviewList);

    expect(readAcceptanceRecordSummaries).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      limit: 200,
    });
    expect(lists).toHaveLength(1);
    expect(lists[0]?.props.records).toEqual([required]);
    expect(lists[0]?.props.workspaceId).toBe(WORKSPACE_ID);
    expect(lists[0]?.props.scanTruncated).toBe(false);
  });

  it("shows generic tool confirmations only when they exist", async () => {
    const pending = [{ id: "approval-1" }];
    vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue(pending as never);

    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    const lists = elementsOfType(page, PendingApprovalsList);

    expect(lists).toHaveLength(1);
    expect(lists[0]?.props).toMatchObject({
      rows: pending,
      workspaceId: WORKSPACE_ID,
      canManage: true,
      hideDollars: true,
    });
  });

  it("does not render an empty generic approvals section", async () => {
    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    expect(elementsOfType(page, PendingApprovalsList)).toHaveLength(0);
  });

  it("keeps review decisions before generic approvals and omits operations panels", async () => {
    vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([{ id: "approval-1" }] as never);
    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    const root = page as ElementLike;
    const [, wrapper] = root.props.children as ElementLike[];
    const sections = (wrapper?.props.children as unknown[]).filter(Boolean) as ElementLike[];

    expect(elementsOfType(sections[0], AcceptanceReviewList)).toHaveLength(1);
    expect(elementsOfType(sections[1], PendingApprovalsList)).toHaveLength(1);
    expect(elementsOfType(page, ParkedWorkList)).toHaveLength(0);
    expect(elementsOfType(page, DeadLettersList)).toHaveLength(0);
  });

  it("does not claim the review queue is empty when the bounded scan is full", async () => {
    vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
      kind: "records",
      records: Array.from({ length: 200 }, (_, index) => ({
        ...recorded,
        recordId: `record-${index}`,
      })),
    } as never);

    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    const [list] = elementsOfType(page, AcceptanceReviewList);
    expect(list?.props.records).toEqual([]);
    expect(list?.props.scanTruncated).toBe(true);
  });

  it("fails closed before data reads for anonymous and non-member sessions", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    await expect(ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) }))
      .rejects.toThrow("NOT_FOUND");
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
    expect(pendingApprovalsForWorkspace).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({ user: { id: USER_ID } } as never);
    vi.mocked(getMembership).mockResolvedValue(undefined as never);
    await expect(ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) }))
      .rejects.toThrow("NOT_FOUND");
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
    expect(pendingApprovalsForWorkspace).not.toHaveBeenCalled();
  });

  it("keeps generic tool actions read-only for ordinary members", async () => {
    vi.mocked(getMembership).mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    } as never);
    vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([{ id: "approval-1" }] as never);

    const page = await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });
    const [list] = elementsOfType(page, PendingApprovalsList);
    expect(list?.props.canManage).toBe(false);
  });
});
