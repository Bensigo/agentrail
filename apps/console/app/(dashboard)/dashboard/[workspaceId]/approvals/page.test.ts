import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  ALIGNMENT_DENIED_PARK_REASON: "alignment-denied",
  deadLettersForWorkspace: vi.fn(),
  getWorkspace: vi.fn(),
  listQueueEntries: vi.fn(),
  pendingApprovalsForWorkspace: vi.fn(),
}));

vi.mock("../../../../../lib/cached", () => ({
  getSession: vi.fn(),
  getMembership: vi.fn(),
}));

import {
  deadLettersForWorkspace,
  getWorkspace,
  listQueueEntries,
  pendingApprovalsForWorkspace,
} from "@agentrail/db-postgres";
import { getMembership, getSession } from "../../../../../lib/cached";
import ApprovalsPage from "./page";
import { PendingApprovalsList } from "./components/pending-approvals-list";

// This repo's vitest config runs with `environment: "node"` — no DOM/render
// harness (no @testing-library/react, no jsdom) — same posture as the
// dashboard's own `page.test.ts`/`layout.test.ts` (see either file's header
// comment). `ApprovalsPage` is an async SERVER component with no hooks of
// its own, so it's safe to call directly: the returned value is a plain
// React element tree walkable via `.type`/`.props`, without a renderer.
//
// This file exists for the `hideDollars` prop threading: it's an *optional*
// prop on `PendingApprovalsList` (default `false`), so dropping the
// `hideDollars={hideDollars}` line from page.tsx's JSX is a silent,
// type-checked-clean regression — tsc has nothing to complain about, since
// the prop simply falls back to its default. Only an assertion on the
// actual prop value threaded through catches that mutation. Unconditional
// since 2026-07-31 owner ruling — `hideDollars` is always `true`, no flag
// involved anymore.

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
  vi.mocked(pendingApprovalsForWorkspace).mockResolvedValue([]);
  vi.mocked(listQueueEntries).mockResolvedValue([]);
  vi.mocked(deadLettersForWorkspace).mockResolvedValue([]);
  vi.mocked(getWorkspace).mockResolvedValue({
    id: WORKSPACE_ID,
    requireAlignment: true,
  } as Awaited<ReturnType<typeof getWorkspace>>);
}

/** Walks to the `<PendingApprovalsList>` element: root children[1] is the
 *  `flex flex-col gap-6` section wrapper; its first `<section>` child holds
 *  [h2, PendingApprovalsList] in that order. */
async function renderPendingApprovalsListElement(): Promise<ReactElementLike> {
  const root = asElement(
    await ApprovalsPage({ params: Promise.resolve({ workspaceId: WORKSPACE_ID }) })
  );
  const [, wrapper] = root.props.children as ReactElementLike[];
  const [pendingSection] = asElement(wrapper).props.children as ReactElementLike[];
  const [, list] = asElement(pendingSection).props.children as ReactElementLike[];
  return asElement(list);
}

describe("ApprovalsPage hideDollars threading (unconditional since 2026-07-31 owner ruling)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it("PendingApprovalsList always carries hideDollars=true", async () => {
    const list = await renderPendingApprovalsListElement();

    expect(list.type).toBe(PendingApprovalsList);
    expect(list.props.hideDollars).toBe(true);
  });

  it("still threads rows/workspaceId/canManage unchanged alongside the prop", async () => {
    const list = await renderPendingApprovalsListElement();

    expect(list.props.workspaceId).toBe(WORKSPACE_ID);
    expect(list.props.canManage).toBe(true);
    expect(list.props.rows).toEqual([]);
  });
});
