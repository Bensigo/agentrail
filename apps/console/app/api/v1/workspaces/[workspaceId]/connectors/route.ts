import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  listWorkspaceRepositories,
} from "@agentrail/db-postgres";
import {
  projectConnectors,
  type ConnectorConfigInput,
} from "../../../../../../app/(dashboard)/dashboard/[workspaceId]/connectors/components/connector-helpers";

/**
 * Connectors read model (M038, AC3). Projects the connector catalog against the
 * workspace's connection state for the management surface. A **Connector**
 * (CONTEXT.md) is the two-way seam between an external tool and the Issue Queue;
 * the GitHub adapter (agentrail/connectors/github.py) is the implemented one.
 *
 * Connection signal: a workspace's GitHub connector counts as *connected* when
 * the workspace has at least one repository linked — a real, falsifiable signal
 * that GitHub is wired to this workspace (the same repos the CLI links). This
 * avoids a fake "connected" flag with no backing; a durable connector-config
 * table can replace this input later without changing the surface.
 *
 * Linear (M038, AC3) is now an implemented adapter (agentrail/connectors/linear.py)
 * and renders as a manageable card. Its connection is keyed on a stored Linear API
 * key for the workspace; until that durable connector-config table exists we
 * surface it honestly as available-but-not-connected (no fake "connected" flag),
 * the same posture GitHub had before repos were linked.
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
    const repos = await listWorkspaceRepositories(workspaceId);
    const githubConnected = repos.length > 0;
    const configs: ConnectorConfigInput[] = [
      {
        kind: "github",
        connected: githubConnected,
        // The label the GitHub adapter ingests by (afk/github.list_queue_issues).
        ingestLabel: "ready-for-agent",
        target: githubConnected
          ? repos.length === 1
            ? repos[0].name
            : `${repos.length} repositories`
          : null,
      },
      {
        // Linear adapter (agentrail/connectors/linear.py). No durable Linear
        // connector-config table yet, so this is honestly not-connected; the card
        // is manageable and flips to connected once a Linear API key is stored.
        kind: "linear",
        connected: false,
        ingestLabel: "ready-for-agent",
        target: null,
      },
    ];
    return NextResponse.json({
      connectors: projectConnectors(configs),
      canManage: membership.role === "owner" || membership.role === "admin",
    });
  } catch (err) {
    console.error("[connectors] failed to project connectors:", err);
    return NextResponse.json(
      { error: "Failed to load connectors" },
      { status: 500 }
    );
  }
}
