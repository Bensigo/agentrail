import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => ({
    type: "a",
    props: { href, children },
  }),
}));

vi.mock("@agentrail/db-postgres", () => ({
  listAcceptanceContextPacksForWorkspace: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import { listAcceptanceContextPacksForWorkspace } from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import { EmptyState } from "../../../../components/empty-state";
import ContextPacksPage from "./page";

type ElementLike = {
  type?: unknown;
  props?: Record<string, unknown>;
};

function findByType(node: unknown, type: unknown): ElementLike[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findByType(child, type));
  const element = node as ElementLike;
  const own = element.type === type ? [element] : [];
  const rendered = typeof element.type === "function"
    ? findByType((element.type as (props: Record<string, unknown>) => unknown)(element.props ?? {}), type)
    : [];
  return [...own, ...rendered, ...findByType(element.props?.children, type)];
}

const workspaceId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-000000000010";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: userId } } as never);
  vi.mocked(getMembership).mockResolvedValue({ role: "member" } as never);
  vi.mocked(listAcceptanceContextPacksForWorkspace).mockResolvedValue([]);
});

async function render() {
  return ContextPacksPage({ params: Promise.resolve({ workspaceId }) });
}

describe("ContextPacksPage", () => {
  it("shows the honest empty state for a member workspace", async () => {
    const rendered = await render();

    expect(listAcceptanceContextPacksForWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId });
    const emptyStates = findByType(rendered, EmptyState);
    expect(emptyStates).toHaveLength(1);
    expect(emptyStates[0]?.props?.title).toBe("No Context Packs");
    expect(emptyStates[0]?.props?.description).toBeUndefined();
  });

  it("lists Pack metadata and links to the canonical Acceptance Record detail", async () => {
    vi.mocked(listAcceptanceContextPacksForWorkspace).mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000011",
      recordId,
      repo: "ada/widgets",
      prNumber: 98,
      compilerVersion: "exact-head-v1",
      policyVersion: "policy-v2",
      createdAt: new Date("2026-08-10T09:00:00.000Z"),
    }]);

    const rendered = await render();
    const links = findByType(rendered, "a");
    expect(links).toHaveLength(1);
    expect(links[0]?.props?.href).toBe(`/dashboard/${workspaceId}/changes/${recordId}`);
  });

  it("does not read Packs without workspace membership", async () => {
    vi.mocked(getMembership).mockResolvedValue(null as never);

    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listAcceptanceContextPacksForWorkspace).not.toHaveBeenCalled();
  });
});
