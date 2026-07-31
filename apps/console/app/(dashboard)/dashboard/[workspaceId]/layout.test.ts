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

import { getSession, getMembership, getWorkspacesForUser } from "../../../../lib/cached";
import { isGoalLoopEnabled } from "@agentrail/db-postgres";
import { isConsoleChatEnabled } from "../../../../lib/chat/feature-flags";
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
// This file used to exist specifically to close a review gap
// `sidebar.test.tsx` and `tsc --noEmit` couldn't: `billingSwapEnabled` used
// to be an *optional* prop on `Sidebar` (default `false`), so dropping the
// `billingSwapEnabled={billingSwapEnabled}` line from either JSX call site
// in layout.tsx was a silent, type-checked-clean regression — tsc had
// nothing to complain about, since the prop simply fell back to its
// default. That gap is closed differently now (2026-07-31 owner ruling —
// subscription slice 8): `billingSwapEnabled` is deleted from
// `SidebarProps` entirely, not just defaulted, so *re-adding* it to either
// call site below is a real `tsc --noEmit` excess-property error, not a
// silent no-op. The tests below pin the positive-space absence anyway
// (same props-walk technique as before) so a partial revert — the prop
// wired back in here AND re-added to `SidebarProps` — still fails loudly
// here even though it would no longer fail typecheck.

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

describe("WorkspaceLayout Sidebar threading (subscription slice 8 — billingSwapEnabled retired 2026-07-31, sidebar filter is unconditional now)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("the Suspense fallback's <Sidebar> carries no billingSwapEnabled prop", async () => {
    const { fallback } = await renderSidebarSites();

    expect(fallback.type).toBe(Sidebar);
    expect(fallback.props.billingSwapEnabled).toBeUndefined();
    expect("billingSwapEnabled" in fallback.props).toBe(false);
  });

  it("the <SidebarWithWorkspaces> element (the Suspense children) carries no billingSwapEnabled prop", async () => {
    const { sidebarWithWorkspaces } = await renderSidebarSites();

    expect(sidebarWithWorkspaces.type).toBe(SidebarWithWorkspaces);
    expect(sidebarWithWorkspaces.props.billingSwapEnabled).toBeUndefined();
    expect("billingSwapEnabled" in sidebarWithWorkspaces.props).toBe(false);
  });

  it("the hop real traffic actually renders: SidebarWithWorkspaces, invoked directly and awaited, passes no billingSwapEnabled through to its inner <Sidebar>", async () => {
    const rendered = asElement(
      await SidebarWithWorkspaces({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        user: { name: "Test User" },
        signOutAction: vi.fn(async () => {}),
        chatEnabled: false,
        goalsEnabled: false,
      })
    );
    expect(rendered.type).toBe(Sidebar);
    expect(rendered.props.billingSwapEnabled).toBeUndefined();
    expect("billingSwapEnabled" in rendered.props).toBe(false);
  });
});
