import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  getWorkspace: vi.fn(),
}));

vi.mock("../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

// loadPlanCardData does its own degraded/no-account/error handling (no flag
// gate anymore — 2026-07-31 owner ruling retired the early
// subscriptionsEnforced() return) — page.tsx just awaits it and threads the
// result through as a prop. Mocked here so this file's tests control the
// resolved value directly rather than depending on real DB/policy
// resolution to produce each case.
vi.mock("../../../../lib/plan-card-data", () => ({
  loadPlanCardData: vi.fn(),
}));

vi.mock("./components/digest-panel", () => ({
  DigestPanel: () => null,
}));

vi.mock("./components/onboarding-banner", () => ({
  OnboardingBanner: () => null,
}));

vi.mock("./components/health-rates-panel", () => ({
  HealthRatesPanel: () => null,
}));

vi.mock("./components/review-metrics-panel", () => ({
  ReviewMetricsPanel: () => null,
}));

import { getWorkspace } from "@agentrail/db-postgres";
import { getSession, getMembership } from "../../../../lib/cached";
import { loadPlanCardData, type PlanCardData } from "../../../../lib/plan-card-data";
import WorkspaceDashboardPage from "./page";
import { PageHeader } from "../../../components/page-header";
import { CopyId } from "../../../components/copy-id";
import { DigestPanel } from "./components/digest-panel";
import { HealthRatesPanel } from "./components/health-rates-panel";

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

/** Recursively walks a React element tree via `.props.children` (the only
 * composition path this file's server-component calls produce) collecting
 * every element whose `.type` matches. Used to prove HealthRatesPanel is
 * mounted nowhere in the tree — not merely absent from its one expected
 * slot — when planCard is undefined. */
function findElementsByType(
  node: unknown,
  type: unknown,
  found: ReactElementLike[] = []
): ReactElementLike[] {
  if (node === null || typeof node !== "object") {
    return found;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      findElementsByType(child, type, found);
    }
    return found;
  }
  const element = node as ReactElementLike;
  if (element.type === type) {
    found.push(element);
  }
  const children = (element.props as Record<string, unknown> | undefined)?.children;
  if (children !== undefined) {
    findElementsByType(children, type, found);
  }
  return found;
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
  // Explicit default (not just vi.fn()'s implicit undefined return) so this
  // happy path's outcome doesn't depend on an unstated mock default —
  // undefined is also the correct flag-off/degraded/error value from a real
  // loadPlanCardData, so this keeps every pre-existing test in this
  // describe block on the exact same "no plan card" rendering path.
  vi.mocked(loadPlanCardData).mockResolvedValue(undefined);
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

/** Walks to the (mocked) DigestPanel element: root children[1] is the
 *  `mt-2 flex flex-col gap-6` wrapper div; its children are
 *  [OnboardingBanner, DigestPanel] in that order. */
async function renderDigestPanel(): Promise<ReactElementLike> {
  const element = asElement(
    await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    })
  );
  const [, wrapper] = element.props.children as ReactElementLike[];
  const [, digestPanel] = asElement(wrapper).props.children as ReactElementLike[];
  return asElement(digestPanel);
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
});

describe("WorkspaceDashboardPage plan-card prop threading (subscription slice 6 Task 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("awaits loadPlanCardData with this workspace's id", async () => {
    await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(loadPlanCardData).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID);
  });

  it("threads an undefined loadPlanCardData result straight through as DigestPanel's planCard prop (degraded workspace / no billing account / a swallowed read error)", async () => {
    vi.mocked(loadPlanCardData).mockResolvedValue(undefined);

    const digestPanel = await renderDigestPanel();

    expect(digestPanel.props.workspaceId).toBe(WORKSPACE_ID);
    expect(digestPanel.props.planCard).toBeUndefined();
  });

  it("threads a resolved PlanCardData object through as DigestPanel's planCard prop, unmodified", async () => {
    const planCard: PlanCardData = {
      hasPlan: true,
      planLabel: "Growth",
      seatsUsed: 3,
      seatLimit: 10,
      capacityUsed: 42,
      capacityTotal: 200,
      renewalText: "Renews Aug 30, 2026",
      shippedAllTime: 128,
    };
    vi.mocked(loadPlanCardData).mockResolvedValue(planCard);

    const digestPanel = await renderDigestPanel();

    expect(digestPanel.props.planCard).toBe(planCard);
  });

  it("still returns PageHeader as children[0] when a plan card is present (no new sibling inserted above it)", async () => {
    vi.mocked(loadPlanCardData).mockResolvedValue({
      hasPlan: true,
      planLabel: "Growth",
      seatsUsed: 3,
      seatLimit: 10,
      capacityUsed: 42,
      capacityTotal: 200,
      renewalText: "Renews Aug 30, 2026",
      shippedAllTime: 128,
    });

    const header = await renderHeader();

    expect(header.type).toBe(PageHeader);
  });
});

describe("WorkspaceDashboardPage HealthRatesPanel mount (subscription slice 6 Task 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("planCard undefined (degraded workspace / no billing account / a swallowed read error): mounts no HealthRatesPanel anywhere in the tree", async () => {
    vi.mocked(loadPlanCardData).mockResolvedValue(undefined);

    const root = await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });

    expect(findElementsByType(root, HealthRatesPanel)).toHaveLength(0);
  });

  it("planCard present: mounts HealthRatesPanel as the sibling after DigestPanel inside the gap-6 stack, with the workspaceId prop", async () => {
    const planCard: PlanCardData = {
      hasPlan: true,
      planLabel: "Growth",
      seatsUsed: 3,
      seatLimit: 10,
      capacityUsed: 42,
      capacityTotal: 200,
      renewalText: "Renews Aug 30, 2026",
      shippedAllTime: 128,
    };
    vi.mocked(loadPlanCardData).mockResolvedValue(planCard);

    const root = await WorkspaceDashboardPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
    });
    const element = asElement(root);
    const [, wrapper] = element.props.children as ReactElementLike[];
    const wrapperChildren = asElement(wrapper).props.children as ReactElementLike[];
    const [, digestPanel, reviewMetricsPanel, healthRatesPanel] = wrapperChildren;

    expect(asElement(digestPanel).type).toBe(DigestPanel);
    expect(reviewMetricsPanel).toBeDefined();
    expect(asElement(healthRatesPanel).type).toBe(HealthRatesPanel);
    expect(asElement(healthRatesPanel).props.workspaceId).toBe(WORKSPACE_ID);

    // Cross-check via the same whole-tree search the "undefined" case uses
    // above — exactly one mount, not merely "found at the expected index".
    expect(findElementsByType(root, HealthRatesPanel)).toHaveLength(1);
  });
});
