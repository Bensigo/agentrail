import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-clickhouse", () => ({
  getFailureById: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getFailureResolution: vi.fn(),
  getRepository: vi.fn(),
  getGithubToken: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock("./failure-explanations", () => ({
  explainFailure: vi.fn(() => ({
    title: "Test failure",
    category: "test_error",
    summary: "A test failure summary.",
    why: ["reason one"],
    whatToCheck: ["check one"],
  })),
  severityMeaning: vi.fn(() => ({ level: "high", impact: "impact text" })),
}));

vi.mock("./github-slug", () => ({
  parseGithubSlug: vi.fn(() => null),
}));

vi.mock("./failure-actions", () => ({
  FailureActions: () => null,
}));

import { getFailureById } from "@agentrail/db-clickhouse";
import {
  getFailureResolution,
  getRepository,
  getGithubToken,
  getConnector,
} from "@agentrail/db-postgres";
import FailureDetailPage from "./page";
import { CopyId } from "../../../../../components/copy-id";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const FAILURE_ID = "evt-full-event-id-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REPO_ID = "11111111-1111-4111-8111-111111111111";

function baseFailure(overrides?: Partial<Record<string, unknown>>) {
  return {
    event_id: FAILURE_ID,
    workspace_id: WORKSPACE_ID,
    run_id: "run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository_id: REPO_ID,
    failure_type: "test_error",
    message: "boom",
    normalized_error: "boom",
    evidence: "{}",
    phase: "test",
    severity: "high",
    occurred_at: "2026-07-18T00:00:00.000Z",
    fingerprint: "",
    ...overrides,
  };
}

// This repo's vitest environment is "node" — no DOM/render harness exists
// (no @testing-library/react, no jsdom). `FailureDetailPage` is an async
// SERVER component with no hooks of its own, so calling it directly and
// walking the returned plain React-element tree via `.type`/`.props` is
// the render assertion this repo's test infra actually supports (same
// technique as the sibling Home-page test). `Field` isn't exported from
// page.tsx, so we match structurally on its `label` prop instead of type
// identity.
function findByLabel(node: unknown, label: string): any {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByLabel(child, label);
      if (found) return found;
    }
    return null;
  }
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) return null;
  if (el.props.label === label) return el;
  if ("children" in el.props) return findByLabel(el.props.children, label);
  return null;
}

describe("FailureDetailPage (#1283 names over ids)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getFailureResolution).mockResolvedValue(null as any);
    vi.mocked(getGithubToken).mockResolvedValue(null as any);
    vi.mocked(getConnector).mockResolvedValue(null as any);
  });

  it("Event ID field renders a CopyId affordance carrying the full id, not bare text", async () => {
    vi.mocked(getFailureById).mockResolvedValue(baseFailure() as any);
    vi.mocked(getRepository).mockResolvedValue(null as any);

    const element = await FailureDetailPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, failureId: FAILURE_ID }),
      searchParams: Promise.resolve({}),
    });

    const eventIdField = findByLabel(element, "Event ID");
    expect(eventIdField).not.toBeNull();
    const copyIdEl = eventIdField.props.children;
    expect(copyIdEl.type).toBe(CopyId);
    expect(copyIdEl.props.id).toBe(FAILURE_ID);
  });

  it("Repository field shows a short hash + title tooltip when no repo name resolves", async () => {
    vi.mocked(getFailureById).mockResolvedValue(baseFailure() as any);
    vi.mocked(getRepository).mockResolvedValue(null as any); // repo lookup absent/fails

    const element = await FailureDetailPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, failureId: FAILURE_ID }),
      searchParams: Promise.resolve({}),
    });

    const repoField = findByLabel(element, "Repository");
    const span = repoField.props.children;
    expect(span.props.children).not.toBe(REPO_ID); // never the full raw id as text
    expect(span.props.children).toBe("11111111…");
    expect(span.props.title).toBe(REPO_ID); // full id still reachable via tooltip
  });

  it("Repository field shows the human repo name (no tooltip needed) once resolved", async () => {
    vi.mocked(getFailureById).mockResolvedValue(baseFailure() as any);
    vi.mocked(getRepository).mockResolvedValue({
      id: REPO_ID,
      name: "agentrail-console",
      url: "https://github.com/agentrail/console",
    } as any);

    const element = await FailureDetailPage({
      params: Promise.resolve({ workspaceId: WORKSPACE_ID, failureId: FAILURE_ID }),
      searchParams: Promise.resolve({}),
    });

    const repoField = findByLabel(element, "Repository");
    const span = repoField.props.children;
    expect(span.props.children).toBe("agentrail-console");
    expect(span.props.title).toBeUndefined();
  });
});
