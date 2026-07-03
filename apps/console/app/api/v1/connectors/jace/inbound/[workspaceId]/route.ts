import { NextRequest, NextResponse } from "next/server";
import {
  getConnector,
  findEnabledJaceWorkspace,
  jaceInboundAllowed,
} from "@agentrail/db-postgres";

/**
 * Inbound Jace webhook (#1038) — the ONE real boundary where an external channel
 * hands an inbound message to the Jace coordinator, and the ONE place the Jace
 * KILL SWITCH is enforced.
 *
 * Jace runs as a self-hosted Eve sidecar (`http://127.0.0.1:2000`, see
 * `apps/jace`). Jace itself is deliberately factory-agnostic and has no DB
 * access, so the kill switch cannot live inside the sidecar. Instead this route
 * is the upstream gate: an inbound channel POSTs the user's message here, and we
 * forward it to the sidecar ONLY when the workspace's `jace` connector is
 * enabled. Flip that connector to `enabled=false` in the console and inbound
 * Jace HALTS here — the request never reaches the sidecar, so no coordinator
 * turn runs.
 *
 * THE FACTORY IS UNAFFECTED. The AgentRail factory (github issue intake → queue
 * → runner) reads a SEPARATE `github` connector row (see the github webhook
 * route + `findWorkspaceByRepo`). Because `jace` and `github` are distinct
 * provider rows on the same table, disabling `jace` cannot touch factory intake
 * — already-queued issues run to completion (AC4).
 *
 * Mirrors the telegram/github webhook routes: workspace comes from the URL path
 * param, we gate defensively, and a bad/halted request is a quiet no-op rather
 * than a 500.
 */

// Where the Jace Eve sidecar listens (see apps/jace README "Topology").
const EVE_HOST = process.env["EVE_HOST"] || "http://127.0.0.1:2000";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  // KILL SWITCH — the DB-layer half. `findEnabledJaceWorkspace` returns the
  // workspace id only when a `jace` connector row exists AND is enabled (its SQL
  // filters `provider='jace' AND enabled=true`). A null means either no jace
  // connector or the operator flipped the kill switch: halt before the sidecar.
  const enabledWorkspace = await findEnabledJaceWorkspace(workspaceId);
  if (!enabledWorkspace) {
    // Re-derive the human-readable reason from the pure decision so the halt
    // response says WHY (no jace row vs. disabled), keeping the two kill-switch
    // helpers in lockstep at the boundary.
    const connector = await getConnector(workspaceId, "jace");
    const decision = jaceInboundAllowed(connector);
    return NextResponse.json(
      {
        halted: true,
        reason: decision.allowed ? "jace inbound disabled" : decision.reason,
      },
      { status: 403 }
    );
  }

  // Allowed: forward the inbound message to the Jace sidecar. We only reach this
  // line when the kill switch is OFF (connector enabled), so the sidecar can
  // never be driven while inbound Jace is disabled.
  const body = await request.text();
  try {
    const upstream = await fetch(`${EVE_HOST}/eve/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const payload = await upstream.text();
    return new NextResponse(payload, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    // The sidecar being down is an availability problem, not a bad request — the
    // gate already passed. Surface a 502 rather than a 500 and never throw out.
    return NextResponse.json(
      { forwarded: false, reason: "jace sidecar unreachable" },
      { status: 502 }
    );
  }
}
