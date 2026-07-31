import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  db,
  getWorkspaceMembership,
  createInvite,
  listInvites,
  countActiveSeats,
} from "@agentrail/db-postgres";
import { resolvePolicyForWorkspace } from "../../../../../../lib/policy/resolve-policy";
import { subscriptionsEnforced } from "../../../../../../lib/policy/feature-flags";

const ADMIN_ROLES = ["owner", "admin"] as const;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const invites = await listInvites(workspaceId);

  return NextResponse.json({
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      token: i.token,
      status: i.status,
      invited_by_user_id: i.invitedByUserId,
      created_at: i.createdAt.toISOString(),
      expires_at: i.expiresAt.toISOString(),
    })),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!ADMIN_ROLES.includes(membership.role as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json(
      { error: "Owner or admin role required" },
      { status: 403 }
    );
  }

  // Seat gate (subscription platform spec §6 point 1 / slice 5 Task 6):
  // refuse a NEW invite once the billing account is already at its seat
  // limit. Placed BEFORE email validation/createInvite — deliberately: this
  // also blocks a re-invite (upsert of an existing pending invite) once at
  // cap, which is acceptable per the plan (the 409's own copy already
  // points the admin at removing a member or upgrading). No
  // `upgrade_prompt_events` row here: this is a synchronous error surfaced
  // straight back to the caller (`invite-member-dialog.tsx` parses
  // `body.error` and shows it inline), not an async prompt a cooldown would
  // need to dedup.
  //
  // subscriptionsEnforced() gates the WHOLE block first (spec §6: one
  // kill-switch, four gates) — flag off costs nothing beyond that one
  // boolean read, byte-identical to today. `degraded` or a null
  // `billingAccountId` skips the gate entirely (resolvePolicyForWorkspace's
  // own contract: not safe to enforce against possibly-wrong data). The
  // zero-spend `fetchMonthSpendUsd` stub matches the chat seat gate's own
  // (`applySeatGateForServedTurn`, `apps/console/lib/channel-dispatch.ts`)
  // and the runner capacity gate's
  // (`apps/console/app/api/v1/runner/claim/route.ts`) — this gate never
  // reads `policy.economics`, only `seatLimit`/`billingAccountId`/
  // `degraded`, so paying for the real ClickHouse fan-out on every invite
  // POST (while the flag is on) is pure waste. Any future reader of THIS
  // resolution that starts touching `policy.economics` must remove the
  // stub first.
  //
  // Everything below lives inside ONE try/catch: §6's fail-open rule — a
  // thrown error anywhere here must never block an invite, only a loud,
  // namespaced `console.error` and a fall-through to the normal
  // create-invite path below.
  if (subscriptionsEnforced()) {
    try {
      const resolved = await resolvePolicyForWorkspace(workspaceId, {
        fetchMonthSpendUsd: async () => 0,
      });
      if (!resolved.degraded && resolved.billingAccountId) {
        const seats = await countActiveSeats(db, resolved.billingAccountId);
        if (seats >= resolved.policy.seatLimit) {
          return NextResponse.json(
            {
              error:
                "You've reached your team's seat limit. Upgrade your plan or remove an inactive member.",
            },
            { status: 409 }
          );
        }
      }
    } catch (err) {
      console.error("[invites] seat gate failed open:", err);
    }
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    role?: string;
  };

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { error: "Valid email is required" },
      { status: 400 }
    );
  }

  if (body.role === "owner") {
    return NextResponse.json(
      { error: "Cannot invite with owner role" },
      { status: 400 }
    );
  }

  const role =
    body.role === "admin" || body.role === "member" || body.role === "viewer"
      ? body.role
      : "member";

  const invite = await createInvite({
    workspaceId,
    email,
    role,
    invitedByUserId: session.user.id,
  });

  return NextResponse.json(
    {
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        token: invite.token,
        status: invite.status,
        invited_by_user_id: invite.invitedByUserId,
        created_at: invite.createdAt.toISOString(),
        expires_at: invite.expiresAt.toISOString(),
      },
    },
    { status: 201 }
  );
}
