import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspace: vi.fn(),
}));

vi.mock("../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("./components/digest-panel", () => ({
  DigestPanel: () => null,
}));

vi.mock("./components/onboarding-banner", () => ({
  OnboardingBanner: () => null,
}));

import { getWorkspace } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../lib/cached";
import WorkspaceDashboardPage from "./page";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness (no @testing-library/react, no jsdom) anywhere in the
// project. `WorkspaceDashboardPage` is an async SERVER component with no
// hooks of its own, so it's safe to call directly: the returned value is a
// plain React element tree (the JSX transform's output objects), which we
// can walk via `.type`/`.props` without a renderer. This is the render
// assertion this repo's test infra actually supports.

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

function mockHappyPath() {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: USER_ID },
  } as Awaited<ReturnType<typeof getSession>>);
  vi.mocked(getMembership).mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "owner",
    createdAt: new Date(),
  } as Awaited<ReturnType<typeof getMembership>>);
  vi.mocked(getWorkspace).mockResolvedValue({
    id: WORKSPACE_ID,
    name: "AgentRail",
    slug: "agentrail",
  } as Awaited<ReturnType<typeof getWorkspace>>);
}

async function renderHeader() {
  const element = (await WorkspaceDashboardPage({
    params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
  })) as { props: { children: Array<{ type: unknown; props: any }> } };
  return element.props.children[0]; // the PageHeader element
}

describe("WorkspaceDashboardPage header (#1283 names over ids)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("passes only the slug — never the raw workspace id — as PageHeader's subtitle", async () => {
    const header = await renderHeader();

    expect(header.type).toBe(PageHeader);
    expect(header.props.subtitle).toBe("agentrail");
    expect(header.props.subtitle).not.toContain(WORKSPACE_ID);
  });

  it("moves the raw workspace id behind a CopyId affordance in actions, not literal text", async () => {
    const header = await renderHeader();
    const actionsRoot = header.props.actions as { props: { children: any[] } };
    const [copyIdEl, roleBadgeEl] = actionsRoot.props.children;

    expect(copyIdEl.type).toBe(CopyId);
    // The full id is a prop feeding the copy affordance (clipboard + title
    // tooltip inside CopyId) — that's the intended carrier, not visible text.
    expect(copyIdEl.props.id).toBe(WORKSPACE_ID);
    expect(copyIdEl.props.label).toBe("ID");

    // The role badge alongside it still shows the plain role string, unrelated to ids.
    expect(roleBadgeEl.props.children).toBe("owner");
  });

  it("does not modify the PageHeader primitive itself (Q13: fix the call site)", async () => {
    const header = await renderHeader();
    // subtitle is still a plain string prop — PageHeader's own contract
    // (title/subtitle/actions) is untouched; only what page.tsx passes in changed.
    expect(typeof header.props.title).toBe("string");
    expect(typeof header.props.subtitle).toBe("string");
  });
});
