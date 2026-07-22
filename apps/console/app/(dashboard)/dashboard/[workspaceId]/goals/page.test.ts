import { describe, it, expect, vi, beforeEach } from "vitest";

// This repo's vitest environment is "node" — no DOM/render harness. GoalsPage
// is an async SERVER component with no hooks of its own, so calling it
// directly and walking the returned plain React-element tree via
// `.type`/`.props` is the render assertion this repo's test infra actually
// supports (same technique as `dashboard/[workspaceId]/page.test.ts` and
// `(auth)/signup/[token]/page.test.ts`). `notFound` is mocked as a plain
// `vi.fn()` (it does not throw here, unlike the real Next.js implementation)
// — every call site in the page itself does `return notFound();`, so
// execution still stops correctly under this mock.

vi.mock("@agentrail/db-postgres", () => ({
  isGoalLoopEnabled: vi.fn(),
  listGoalsForWorkspace: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => undefined),
}));

import { isGoalLoopEnabled, listGoalsForWorkspace } from "@agentrail/db-postgres";
import type { Goal } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../../lib/cached";
import { notFound } from "next/navigation";
import GoalsPage from "./page";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

const mockGetSession = vi.mocked(getSession);
const mockGetMembership = vi.mocked(getMembership);
const mockIsGoalLoopEnabled = vi.mocked(isGoalLoopEnabled);
const mockListGoalsForWorkspace = vi.mocked(listGoalsForWorkspace);
const mockNotFound = vi.mocked(notFound);

function activeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-active",
    workspaceId: WORKSPACE_ID,
    repositoryId: "repo-1",
    objective: "reach 80% coverage",
    slug: "coverage-80",
    checkType: "metric",
    checkMetric: "green_run_count",
    checkThreshold: 5,
    checkCommand: null,
    status: "active",
    statusReason: null,
    maxIssues: 10,
    maxSpendUsd: 50,
    issuesFiled: 3,
    spendUsd: 12.5,
    stuckThreshold: 2,
    consecutiveNonGreen: 0,
    greenCount: 1,
    createdByEveSessionId: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

function doneGoal(overrides: Partial<Goal> = {}): Goal {
  return activeGoal({
    id: "goal-done",
    status: "leashed",
    statusReason: "leash exhausted: issues filed 10/10",
    issuesFiled: 10,
    maxIssues: 10,
    ...overrides,
  });
}

function mockAuthedMember() {
  mockGetSession.mockResolvedValue({
    user: { id: USER_ID },
  } as Awaited<ReturnType<typeof getSession>>);
  mockGetMembership.mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "owner",
    createdAt: new Date(),
  } as Awaited<ReturnType<typeof getMembership>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GoalsPage auth", () => {
  it("404s (never reads goals) when there is no session", async () => {
    mockGetSession.mockResolvedValue(null as Awaited<ReturnType<typeof getSession>>);

    await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockGetMembership).not.toHaveBeenCalled();
    expect(mockIsGoalLoopEnabled).not.toHaveBeenCalled();
  });

  it("404s when the user is not a member of this workspace", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
    } as Awaited<ReturnType<typeof getSession>>);
    mockGetMembership.mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getMembership>>
    );

    await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockIsGoalLoopEnabled).not.toHaveBeenCalled();
    expect(mockListGoalsForWorkspace).not.toHaveBeenCalled();
  });
});

describe("GoalsPage flag gating (jaceGoalLoop, default OFF)", () => {
  it("404s when isGoalLoopEnabled is false — the page doesn't exist until rollout, same posture as console chat", async () => {
    mockAuthedMember();
    mockIsGoalLoopEnabled.mockResolvedValue(false);

    await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(mockIsGoalLoopEnabled).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockListGoalsForWorkspace).not.toHaveBeenCalled();
  });

  it("renders (no notFound call) when the flag is on", async () => {
    mockAuthedMember();
    mockIsGoalLoopEnabled.mockResolvedValue(true);
    mockListGoalsForWorkspace.mockResolvedValue({ active: [], done: [] });

    await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(mockNotFound).not.toHaveBeenCalled();
  });
});

describe("GoalsPage content", () => {
  beforeEach(() => {
    mockAuthedMember();
    mockIsGoalLoopEnabled.mockResolvedValue(true);
  });

  it("renders the page-level empty state when there are no goals at all", async () => {
    mockListGoalsForWorkspace.mockResolvedValue({ active: [], done: [] });

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const children = element.props.children as ReactElementLike[];
    const emptyState = asElement(children[1]);

    expect(emptyState.props.title).toBe("No goals yet");
  });

  it("passes active goals to the Active section and done goals to the Done section, unmixed", async () => {
    const active = [activeGoal()];
    const done = [doneGoal()];
    mockListGoalsForWorkspace.mockResolvedValue({ active, done });

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const wrapper = element.props.children as ReactElementLike[];
    const sectionsRoot = asElement(wrapper[1]);
    const [activeSection, doneSection] = sectionsRoot.props.children as ReactElementLike[];

    const [, activeBody] = activeSection.props.children as ReactElementLike[];
    const activeCards = activeBody.props.children as ReactElementLike[];
    expect(activeCards).toHaveLength(1);
    expect((activeCards[0].props.goal as { id: string }).id).toBe("goal-active");

    const [, doneBody] = doneSection.props.children as ReactElementLike[];
    const doneCards = doneBody.props.children as ReactElementLike[];
    expect(doneCards).toHaveLength(1);
    expect((doneCards[0].props.goal as { id: string }).id).toBe("goal-done");
  });
});
