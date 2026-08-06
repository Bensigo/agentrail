import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pageSource = readFileSync(
  fileURLToPath(new URL("./page.tsx", import.meta.url)),
  "utf8"
);

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspace: vi.fn(),
  listChangeRecords: vi.fn(),
  readAcceptanceWorkspaceOutcomeSummary: vi.fn(),
}));

vi.mock("../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("./components/onboarding-banner", () => ({
  OnboardingBanner: () => null,
}));

vi.mock("./components/acceptance-evidence-panel", () => ({
  AcceptanceEvidencePanel: () => null,
}));

vi.mock("./components/acceptance-outcome-summary", () => ({
  AcceptanceOutcomeSummaryPanel: () => null,
  workspaceOutcomeSummaryWindow: () => ({
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-08-31T00:00:00.000Z"),
  }),
}));

import { getWorkspace } from "@agentrail/db-postgres";
import { listChangeRecords } from "@agentrail/db-postgres";
import { readAcceptanceWorkspaceOutcomeSummary } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../lib/cached";
import WorkspaceDashboardPage from "./page";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";
import { AcceptanceEvidencePanel } from "./components/acceptance-evidence-panel";
import { AcceptanceOutcomeSummaryPanel } from "./components/acceptance-outcome-summary";
import { OnboardingBanner } from "./components/onboarding-banner";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness (no @testing-library/react, no jsdom) anywhere in the
// project. `WorkspaceDashboardPage` is an async SERVER component with no
// hooks of its own, so it's safe to call directly: the returned value is a
// plain React element tree (the JSX transform's output objects), which we
// can walk via `.type`/`.props` without a renderer. This is the render
// assertion this repo's test infra actually supports.

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
  vi.mocked(listChangeRecords).mockResolvedValue([]);
  vi.mocked(readAcceptanceWorkspaceOutcomeSummary).mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    windowFromUtcInclusive: new Date("2026-08-01T00:00:00.000Z"),
    windowToUtcExclusive: new Date("2026-08-31T00:00:00.000Z"),
    countedAtUtc: new Date("2026-08-31T00:00:00.000Z"),
    reviewedPrRevisionCount: 0,
    jaceVerdicts: { proven: 0, notProven: 0, otherStatuses: {} },
    humanDecisions: {
      approved: 0,
      changesRequested: 0,
      rejected: 0,
      approvedWithException: 0,
    },
    pendingReviews: { queued: 0, claimed: 0, total: 0 },
    pendingHumanDecisions: 0,
  } as Awaited<ReturnType<typeof readAcceptanceWorkspaceOutcomeSummary>>);
}

async function renderHeader(): Promise<ReactElementLike> {
  const element = asElement(
    await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    })
  );
  const children = element.props.children as ReactElementLike[];
  return children[0]; // the PageHeader element
}

describe("WorkspaceDashboardPage header (#1283 names over ids)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
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
    const actionsRoot = asElement(header.props.actions);
    const [copyIdEl, roleBadgeEl] = actionsRoot.props.children as ReactElementLike[];

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

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe("WorkspaceDashboardPage acceptance evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
    vi.clearAllMocks();
    mockHappyPath();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the five latest Change/Acceptance Record headers for this workspace", async () => {
    await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(listChangeRecords).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      limit: 5,
    });
    expect(readAcceptanceWorkspaceOutcomeSummary).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      fromUtcInclusive: new Date("2026-08-01T00:00:00.000Z"),
      toUtcExclusive: new Date("2026-08-31T00:00:00.000Z"),
    });
  });

  it("renders OnboardingBanner, then the outcome summary, then AcceptanceEvidencePanel with all five records", async () => {
    const records = [
      { id: "record-1" },
      { id: "record-2" },
      { id: "record-3" },
      { id: "record-4" },
      { id: "record-5" },
    ];
    vi.mocked(listChangeRecords).mockResolvedValue(records as never);

    const root = await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    const element = asElement(root);
    const [, wrapper] = element.props.children as ReactElementLike[];
    const [onboardingBanner, outcomeSummaryPanel, acceptancePanel] = asElement(wrapper).props
      .children as ReactElementLike[];

    expect(asElement(onboardingBanner).type).toBe(OnboardingBanner);
    expect(asElement(outcomeSummaryPanel).type).toBe(AcceptanceOutcomeSummaryPanel);
    expect(asElement(acceptancePanel).type).toBe(AcceptanceEvidencePanel);
    expect(asElement(acceptancePanel).props.workspaceId).toBe(WORKSPACE_ID);
    expect(asElement(acceptancePanel).props.records).toBe(records);
  });
});

describe("WorkspaceDashboardPage trust-layer surface", () => {
  it("does not import or use legacy digest, health, or plan-card reads", () => {
    expect(pageSource).not.toContain("DigestPanel");
    expect(pageSource).not.toContain("HealthRatesPanel");
    expect(pageSource).not.toContain("loadPlanCardData");
    expect(pageSource).not.toContain("review-metrics");
  });
});
