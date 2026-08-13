import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspace: vi.fn(),
  readAcceptanceRecordSummaries: vi.fn(),
}));

vi.mock("../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("./components/onboarding-banner", () => ({
  OnboardingBanner: () => null,
}));

vi.mock("./components/acceptance-outcome-metrics-panel", () => ({
  AcceptanceOutcomeMetricsPanel: () => null,
}));

vi.mock("./components/acceptance-record-summary-list", () => ({
  AcceptanceRecordSummaryList: () => null,
}));

import { getWorkspace, readAcceptanceRecordSummaries } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../lib/cached";
import { CopyId } from "../../../components/copy-id";
import { PageHeader } from "../../../components/page-header";
import { AcceptanceOutcomeMetricsPanel } from "./components/acceptance-outcome-metrics-panel";
import { AcceptanceRecordSummaryList } from "./components/acceptance-record-summary-list";
import { OnboardingBanner } from "./components/onboarding-banner";
import WorkspaceDashboardPage from "./page";

// This repo's vitest config runs in Node. WorkspaceDashboardPage is an async
// server component with no hooks, so its returned React element tree can be
// inspected directly without a DOM renderer.
interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

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
  vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
    kind: "records",
    records: [],
  } as never);
}

async function renderPage(): Promise<ReactElementLike> {
  return asElement(
    await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    })
  );
}

async function renderHeader(): Promise<ReactElementLike> {
  const page = await renderPage();
  const children = page.props.children as ReactElementLike[];
  return children[0];
}

describe("WorkspaceDashboardPage header (#1283 names over ids)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("passes only the slug, never the raw workspace id, as the subtitle", async () => {
    const header = await renderHeader();

    expect(header.type).toBe(PageHeader);
    expect(header.props.subtitle).toBe("agentrail");
    expect(header.props.subtitle).not.toContain(WORKSPACE_ID);
  });

  it("keeps the raw workspace id behind the CopyId affordance", async () => {
    const header = await renderHeader();
    const actionsRoot = asElement(header.props.actions);
    const [copyId, roleBadge] = actionsRoot.props.children as ReactElementLike[];

    expect(copyId.type).toBe(CopyId);
    expect(copyId.props).toMatchObject({ id: WORKSPACE_ID, label: "ID" });
    expect(roleBadge.props.children).toBe("owner");
  });
});

describe("WorkspaceDashboardPage trust-layer composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("renders only onboarding, tenant-scoped Acceptance Records, and outcomes", async () => {
    const summaries = [{ recordId: "record-1" }];
    vi.mocked(readAcceptanceRecordSummaries).mockResolvedValue({
      kind: "records",
      records: summaries,
    } as never);

    const page = await renderPage();
    const [, content] = page.props.children as ReactElementLike[];
    const panels = asElement(content).props.children as ReactElementLike[];

    expect(readAcceptanceRecordSummaries).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      limit: 5,
    });
    expect(panels).toHaveLength(3);
    expect(panels[0]?.type).toBe(OnboardingBanner);
    expect(panels[0]?.props.workspaceId).toBe(WORKSPACE_ID);
    expect(panels[1]?.type).toBe(AcceptanceRecordSummaryList);
    expect(panels[1]?.props).toMatchObject({
      workspaceId: WORKSPACE_ID,
      records: summaries,
      compact: true,
    });
    expect(panels[2]?.type).toBe(AcceptanceOutcomeMetricsPanel);
    expect(panels[2]?.props.workspaceId).toBe(WORKSPACE_ID);
  });

  it("does not read Acceptance Records for a non-member workspace", async () => {
    vi.mocked(getMembership).mockResolvedValue(null as never);

    await expect(renderPage()).rejects.toBeDefined();
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });

  it("does not resolve workspace data without an authenticated user", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    await expect(renderPage()).rejects.toBeDefined();
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(getMembership).not.toHaveBeenCalled();
    expect(readAcceptanceRecordSummaries).not.toHaveBeenCalled();
  });
});
