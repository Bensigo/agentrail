import { describe, it, expect, vi, beforeEach } from "vitest";

// This repo's vitest config runs with `environment: "node"` — there is no
// DOM/render harness. `InvitePage` is an async SERVER component with no
// hooks of its own, so calling it directly returns a plain React element
// tree (the JSX transform's output objects) we can walk via `.type`/`.props`
// without a renderer — same pattern as
// app/(auth)/connect/[token]/page.test.ts and
// app/(auth)/signup/[token]/page.test.ts.
//
// THIS FILE'S REASON TO EXIST: slice 4 Task 3 (spec §5 rule 1) hooks a seat
// claim onto a successful invite accept, AFTER `claimInvitesForUser`'s
// membership insert. This file only tests the WIRING (the page calls the
// shared `claimSeatsForAcceptedInvites` helper with the right
// `claimedWorkspaceIds`/`userId`, awaited before the redirect decision, and
// never on a branch that claimed nothing) — the helper's own exhaustive
// branch coverage (dedup, multi-account, null-account skip, non-fatal error
// handling) lives in ../../../../lib/claim-invite-seats.test.ts, which this
// file deliberately does not re-test.
//
// `next/navigation`'s `redirect` is mocked as a no-op here (same convention
// as the sibling page tests) rather than a throw, so every test below is
// written to reach exactly ONE decision branch per call — see those sibling
// files' own comments for why a no-op mock makes this safe.

vi.mock("@agentrail/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("@agentrail/db-postgres", () => ({
  getInviteByToken: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  claimInvitesForUser: vi.fn(),
}));

vi.mock("../../../../lib/claim-invite-seats", () => ({
  claimSeatsForAcceptedInvites: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import InvitePage from "./page";
import { auth } from "@agentrail/auth";
import {
  getInviteByToken,
  getWorkspaceMembership,
  claimInvitesForUser,
} from "@agentrail/db-postgres";
import { claimSeatsForAcceptedInvites } from "../../../../lib/claim-invite-seats";
import { redirect } from "next/navigation";

const mockAuth = vi.mocked(auth);
const mockGetInviteByToken = vi.mocked(getInviteByToken);
const mockGetWorkspaceMembership = vi.mocked(getWorkspaceMembership);
const mockClaimInvitesForUser = vi.mocked(claimInvitesForUser);
const mockClaimSeatsForAcceptedInvites = vi.mocked(claimSeatsForAcceptedInvites);
const mockRedirect = vi.mocked(redirect);

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

const TOKEN = "invite-token-abc123";
const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";

const VALID_SESSION = {
  user: { id: USER_ID, name: "Ada", email: "ada@example.com" },
  expires: "2099-01-01T00:00:00.000Z",
};

const PENDING_INVITE = {
  id: "invite-1",
  workspaceId: WORKSPACE_ID,
  email: "ada@example.com",
  role: "member" as const,
  token: TOKEN,
  invitedByUserId: "owner-1",
  status: "pending" as const,
  createdAt: new Date("2026-01-01"),
  expiresAt: new Date(Date.now() + 14 * 86400_000),
};

async function renderPage() {
  return asElement(await InvitePage({ params: Promise.resolve({ token: TOKEN }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkspaceMembership.mockResolvedValue(null as never);
  mockClaimSeatsForAcceptedInvites.mockResolvedValue(undefined);
  // `next/navigation`'s `redirect` is mocked as a no-op (see file-top
  // comment) — unlike real Next.js, it does NOT stop execution, so a test
  // that exercises an early `redirect(...)` branch still falls through to
  // the rest of the component body. Give `claimInvitesForUser` a safe
  // default everywhere so that fall-through hits an empty array instead of
  // an unconfigured mock; tests that specifically exercise the claim path
  // override this with their own `mockResolvedValue`.
  mockClaimInvitesForUser.mockResolvedValue([]);
});

describe("InvitePage — pre-claim branches never attempt a seat claim", () => {
  it("no session: renders the sign-in screen, claimInvitesForUser never called", async () => {
    mockAuth.mockResolvedValue(null as never);

    const root = await renderPage();

    expect(root.type).toBe("main");
    expect(mockClaimInvitesForUser).not.toHaveBeenCalled();
  });

  it("invite not found: renders the message, no claim attempted", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as never);
    mockGetInviteByToken.mockResolvedValue(null as never);

    const root = await renderPage();

    expect(root.props.title).toBe("Invite not found");
    expect(mockClaimInvitesForUser).not.toHaveBeenCalled();
  });

  it("already a member: redirects to the dashboard (production stops there; this harness's no-op redirect mock cannot assert claimInvitesForUser is unreached — see beforeEach's comment)", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as never);
    mockGetInviteByToken.mockResolvedValue(PENDING_INVITE as never);
    mockGetWorkspaceMembership.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "member",
      createdAt: new Date(),
    });

    await renderPage();

    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/${WORKSPACE_ID}`);
  });
});

describe("InvitePage — seat claim wiring (spec §5 rule 1, slice 4 Task 3)", () => {
  it("happy path: awaits claimSeatsForAcceptedInvites with the claimed workspace ids and the session user id, then redirects", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as never);
    mockGetInviteByToken
      .mockResolvedValueOnce(PENDING_INVITE as never)
      .mockResolvedValueOnce({ ...PENDING_INVITE, status: "accepted" } as never);
    mockClaimInvitesForUser.mockResolvedValue([WORKSPACE_ID, "ws-2"]);

    await renderPage();

    expect(mockClaimInvitesForUser).toHaveBeenCalledWith({
      userId: USER_ID,
      email: "ada@example.com",
    });
    expect(mockClaimSeatsForAcceptedInvites).toHaveBeenCalledWith(
      [WORKSPACE_ID, "ws-2"],
      USER_ID
    );
    expect(mockRedirect).toHaveBeenCalledWith(`/dashboard/${WORKSPACE_ID}`);
  });

  it("the claim helper is awaited BEFORE the redirect decision (ordering, not just 'eventually called')", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as never);
    mockGetInviteByToken
      .mockResolvedValueOnce(PENDING_INVITE as never)
      .mockResolvedValueOnce({ ...PENDING_INVITE, status: "accepted" } as never);
    mockClaimInvitesForUser.mockResolvedValue([WORKSPACE_ID]);

    const callOrder: string[] = [];
    mockClaimSeatsForAcceptedInvites.mockImplementation(async () => {
      callOrder.push("claimSeats");
    });
    mockRedirect.mockImplementation(() => {
      callOrder.push("redirect");
      return undefined as never;
    });

    await renderPage();

    expect(callOrder).toEqual(["claimSeats", "redirect"]);
  });

  it("email mismatch (nothing claimed): the helper still runs with an empty array — a no-op per its own contract — and no redirect happens", async () => {
    mockAuth.mockResolvedValue(VALID_SESSION as never);
    mockGetInviteByToken
      .mockResolvedValueOnce(PENDING_INVITE as never)
      .mockResolvedValueOnce({ ...PENDING_INVITE, status: "pending" } as never);
    mockClaimInvitesForUser.mockResolvedValue([]);

    const root = await renderPage();

    expect(root.props.title).toBe("Email mismatch");
    expect(mockClaimSeatsForAcceptedInvites).toHaveBeenCalledWith([], USER_ID);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
