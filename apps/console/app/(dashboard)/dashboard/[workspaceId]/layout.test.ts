import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/auth", () => ({
  signOut: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  isGoalLoopEnabled: vi.fn(),
}));

vi.mock("../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getWorkspacesForUser: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("../../../../lib/chat/feature-flags", () => ({
  isConsoleChatEnabled: vi.fn(),
}));

// Mocked (rather than left real + toggled via process.env) so each test
// controls billingSwapEnabled's resolved value directly — same reasoning
// page.tsx's own test file gives for mocking loadPlanCardData instead of
// depending on ambient BILLING_SUBSCRIPTIONS_ENFORCED.
vi.mock("../../../../lib/policy/feature-flags", () => ({
  subscriptionsEnforced: vi.fn(),
}));

import { getSession, getMembership, getWorkspacesForUser } from "../../../../lib/cached";
import { isGoalLoopEnabled } from "@agentrail/db-postgres";
import { isConsoleChatEnabled } from "../../../../lib/chat/feature-flags";
import { subscriptionsEnforced } from "../../../../lib/policy/feature-flags";
import WorkspaceLayout, { SidebarWithWorkspaces } from "./layout";
import { Sidebar } from "../../../components/sidebar";

// This repo's vitest config runs with `environment: "node"` — no DOM/render
// harness (no @testing-library/react, no jsdom). `WorkspaceLayout` is an
// async SERVER component with no hooks of its own, so it's safe to call
// directly: the returned value is a plain React element tree walkable via
// `.type`/`.props`, same idiom this folder's own `page.test.ts` uses for
// `WorkspaceDashboardPage`. `Sidebar` and `SidebarWithWorkspaces` are never
// *rendered* by this file — only referenced as `.type` and read via
// `.props` off the elements `WorkspaceLayout`'s JSX constructs, except for
// the one test below that calls `SidebarWithWorkspaces` itself directly
// (it, too, is hook-free — an async server component, safe to call).
//
// This file exists specifically to close a review gap `sidebar.test.tsx`
// and `tsc --noEmit` cannot: `billingSwapEnabled` is an *optional* prop on
// `Sidebar` (default `false`), so dropping the
// `billingSwapEnabled={billingSwapEnabled}` line from either JSX call site
// in layout.tsx is a silent, type-checked-clean regression — tsc has
// nothing to complain about, since the prop simply falls back to its
// default. Only an assertion on the actual prop value threaded through
// each call site catches that mutation.

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

/** Narrows an opaque React element return value for `.type`/`.props` access,
 * without an `any` cast (forbidden by this repo's eslint config). */
function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

function mockHappyPath() {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: USER_ID, name: "Test User", email: "test@example.com" },
  } as Awaited<ReturnType<typeof getSession>>);
  vi.mocked(getMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "owner",
    createdAt: new Date(),
  } as Awaited<ReturnType<typeof getMembership>>);
  vi.mocked(getWorkspacesForUser).mockResolvedValue([]);
  vi.mocked(isGoalLoopEnabled).mockResolvedValue(false);
  vi.mocked(isConsoleChatEnabled).mockReturnValue(false);
}

async function renderLayout(): Promise<ReactElementLike> {
  return asElement(
    await WorkspaceLayout({
      children: null,
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    })
  );
}

/** Walks to the two Sidebar-family elements the Suspense boundary carries:
 *  its `fallback` prop (the direct `<Sidebar>` shown before workspaces
 *  resolve) and its `children` prop (the `<SidebarWithWorkspaces>` element). */
async function renderSidebarSites(): Promise<{
  fallback: ReactElementLike;
  sidebarWithWorkspaces: ReactElementLike;
}> {
  const root = await renderLayout();
  const [suspenseEl] = root.props.children as ReactElementLike[];
  return {
    fallback: asElement(suspenseEl.props.fallback),
    sidebarWithWorkspaces: asElement(suspenseEl.props.children),
  };
}

describe("WorkspaceLayout billingSwapEnabled threading (subscription slice 6 Task 4 — review fix: mutation-tested gap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("subscriptionsEnforced()=true: the Suspense fallback's <Sidebar> carries billingSwapEnabled=true", async () => {
    vi.mocked(subscriptionsEnforced).mockReturnValue(true);

    const { fallback } = await renderSidebarSites();

    expect(fallback.type).toBe(Sidebar);
    expect(fallback.props.billingSwapEnabled).toBe(true);
  });

  it("subscriptionsEnforced()=true: the <SidebarWithWorkspaces> element (the Suspense children) carries billingSwapEnabled=true", async () => {
    vi.mocked(subscriptionsEnforced).mockReturnValue(true);

    const { sidebarWithWorkspaces } = await renderSidebarSites();

    expect(sidebarWithWorkspaces.type).toBe(SidebarWithWorkspaces);
    expect(sidebarWithWorkspaces.props.billingSwapEnabled).toBe(true);
  });

  it("subscriptionsEnforced()=false: both the fallback <Sidebar> and the <SidebarWithWorkspaces> element carry billingSwapEnabled=false", async () => {
    vi.mocked(subscriptionsEnforced).mockReturnValue(false);

    const { fallback, sidebarWithWorkspaces } = await renderSidebarSites();

    expect(fallback.props.billingSwapEnabled).toBe(false);
    expect(sidebarWithWorkspaces.props.billingSwapEnabled).toBe(false);
  });

  it("the hop real traffic actually renders: SidebarWithWorkspaces, invoked directly and awaited, passes billingSwapEnabled through unchanged to its inner <Sidebar>", async () => {
    const withFlagOn = asElement(
      await SidebarWithWorkspaces({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        user: { name: "Test User" },
        signOutAction: vi.fn(async () => {}),
        chatEnabled: false,
        goalsEnabled: false,
        billingSwapEnabled: true,
      })
    );
    expect(withFlagOn.type).toBe(Sidebar);
    expect(withFlagOn.props.billingSwapEnabled).toBe(true);

    const withFlagOff = asElement(
      await SidebarWithWorkspaces({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        user: { name: "Test User" },
        signOutAction: vi.fn(async () => {}),
        chatEnabled: false,
        goalsEnabled: false,
        billingSwapEnabled: false,
      })
    );
    expect(withFlagOff.type).toBe(Sidebar);
    expect(withFlagOff.props.billingSwapEnabled).toBe(false);
  });
});
