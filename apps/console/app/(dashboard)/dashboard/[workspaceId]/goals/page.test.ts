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
  listWorkspaceRepositories: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => undefined),
}));

// NewGoalButton (a "use client" component) is never actually INVOKED by
// this test style — GoalsPage's returned tree is inspected via `.type`/
// `.props` without a render pass (same reasoning this file's header
// comment already gives for ActiveGoalCard/DoneGoalCard, neither of which
// is mocked either), so importing it for real here is safe: its hooks
// (useState/useRouter) never run.
import { isGoalLoopEnabled, listGoalsForWorkspace, listWorkspaceRepositories } from "@agentrail/db-postgres";
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
const mockListWorkspaceRepositories = vi.mocked(listWorkspaceRepositories);
const mockNotFound = vi.mocked(notFound);

function repoRow(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: "repo-1",
    name: "bensigo/agentrail",
    workspaceId: WORKSPACE_ID,
    defaultBranch: "main",
    url: "https://github.com/bensigo/agentrail",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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
    mockListWorkspaceRepositories.mockResolvedValue([]);

    await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) });

    expect(mockNotFound).not.toHaveBeenCalled();
  });
});

describe("GoalsPage content", () => {
  beforeEach(() => {
    mockAuthedMember();
    mockIsGoalLoopEnabled.mockResolvedValue(true);
    // Default: one connected repo, so the pre-existing "goals" assertions
    // below (written before the repo-required New-goal form existed)
    // continue to exercise the SAME "has repos" branch they always did.
    // Tests specifically about the zero-repo gate override this.
    mockListWorkspaceRepositories.mockResolvedValue([repoRow()] as never);
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

describe("GoalsPage 'New goal' — repo-required rule (UI half; the API route's getRepository check is the server-side half)", () => {
  beforeEach(() => {
    mockAuthedMember(); // role: "owner" by default
    mockIsGoalLoopEnabled.mockResolvedValue(true);
  });

  it("shows a 'connect a repository' empty state (not the generic one) when the workspace has zero repos and zero goals", async () => {
    mockListGoalsForWorkspace.mockResolvedValue({ active: [], done: [] });
    mockListWorkspaceRepositories.mockResolvedValue([]);

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const children = element.props.children as ReactElementLike[];
    const connectState = asElement(children[1]);
    const [, heading] = connectState.props.children as ReactElementLike[];

    expect((heading.props.children as string)).toBe("Connect a repository first");
  });

  it("renders a 'connect a repository' link, NOT the New goal button, in the actions slot when there are no repos", async () => {
    mockListGoalsForWorkspace.mockResolvedValue({ active: [activeGoal()], done: [] });
    mockListWorkspaceRepositories.mockResolvedValue([]);

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const wrapper = element.props.children as ReactElementLike[];
    const pageHeader = asElement(wrapper[0]);
    const actions = asElement(pageHeader.props.actions);

    expect(actions.props.href).toBe(`/dashboard/${WORKSPACE_ID}/repos`);
  });

  it("renders the New goal button in the actions slot (with the workspace's repos) when repos exist and the caller can manage", async () => {
    mockListGoalsForWorkspace.mockResolvedValue({ active: [activeGoal()], done: [] });
    mockListWorkspaceRepositories.mockResolvedValue([
      repoRow({ id: "repo-1", name: "bensigo/agentrail" }),
    ] as never);

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const wrapper = element.props.children as ReactElementLike[];
    const pageHeader = asElement(wrapper[0]);
    const actions = asElement(pageHeader.props.actions);

    expect(actions.props.workspaceId).toBe(WORKSPACE_ID);
    expect(actions.props.repositories).toEqual([{ id: "repo-1", name: "bensigo/agentrail" }]);
  });

  it("renders NO action at all for a member/viewer (canManage false) even when repos exist — mirrors the Repos page's own canManage gate", async () => {
    mockGetMembership.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    } as Awaited<ReturnType<typeof getMembership>>);
    mockListGoalsForWorkspace.mockResolvedValue({ active: [activeGoal()], done: [] });
    mockListWorkspaceRepositories.mockResolvedValue([repoRow()] as never);

    const element = asElement(
      await GoalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
    );
    const wrapper = element.props.children as ReactElementLike[];
    const pageHeader = asElement(wrapper[0]);

    expect(pageHeader.props.actions).toBeUndefined();
  });
});
