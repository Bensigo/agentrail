import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listChatIdentitiesForWorkspace,
} from "@agentrail/db-postgres";
import {
  projectGateways,
  type GatewayEnv,
} from "../../../../../(dashboard)/dashboard/[workspaceId]/gateways/components/gateway-helpers";

/**
 * Gateways read surface (gateways-page T2).
 *
 * A **gateway** is where a human talks to Jace — Telegram, Discord, Slack,
 * iMessage, WhatsApp — as distinct from a **connector** (GitHub/Linear/Figma/
 * Context7: a tool wired into the factory, CONTEXT.md/ADR 0010). Gateways
 * used to be filed as the connector catalog's `channel` group; the owner
 * ruled them onto their own Settings page instead (see
 * `gateways/components/gateway-helpers.ts`'s module doc-comment for the full
 * history, the availability-vs-configured split, and the env contract — the
 * invite/install URL plus `*_CHANNEL_LIVE` honesty-gate pair — this route's
 * projection relies on).
 *
 * This route is the read side only — any workspace member may call it,
 * mirroring the connectors route's GET (`app/api/v1/workspaces/[workspaceId]/
 * connectors/route.ts`) for auth, membership, and error-body shape. There is
 * no stored credential to read or write here: a gateway's connection state
 * comes entirely from the chat-identity spine
 * (`listChatIdentitiesForWorkspace`) — a platform counts as connected once
 * the workspace has ≥1 linked chat identity for it, recorded when someone
 * DMs the shared Jace bot. `gateway-helpers.ts`'s `projectGateways` is pure
 * and never reads `process.env` itself, so this route reads the five
 * `NEXT_PUBLIC_*` vars the contract now spans — telegram's bot username,
 * plus discord/slack's `*_INVITE_URL`/`*_INSTALL_URL` + `*_CHANNEL_LIVE`
 * pairs, the SAME pairs the landing page's "also available on" cards read
 * (`app/(marketing)/_channel-cards.ts`) — via static member access (not a
 * dynamically keyed lookup, so Next can inline each one at build time), and
 * passes them in as a `GatewayEnv` bag.
 */
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

  try {
    const identities = await listChatIdentitiesForWorkspace(workspaceId);

    const env: GatewayEnv = {
      telegramBotUsername: process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME,
      discordInviteUrl: process.env.NEXT_PUBLIC_DISCORD_INVITE_URL,
      discordChannelLive: process.env.NEXT_PUBLIC_DISCORD_CHANNEL_LIVE,
      slackInstallUrl: process.env.NEXT_PUBLIC_SLACK_INSTALL_URL,
      slackChannelLive: process.env.NEXT_PUBLIC_SLACK_CHANNEL_LIVE,
    };

    return NextResponse.json({
      gateways: projectGateways(
        // Map to the fields `projectGateways` actually consumes — never
        // forward `platformUserId` into the response (`linkedIdentities` is
        // a display-name-only surface; see `GatewayView`, and mirrors the
        // same map the connectors route does for `ConnectorView`).
        identities.map((identity) => ({
          platform: identity.platform,
          displayName: identity.displayName,
        })),
        env
      ),
    });
  } catch (err) {
    console.error("[gateways] failed to project gateways:", err);
    return NextResponse.json(
      { error: "Failed to load gateways" },
      { status: 500 }
    );
  }
}
