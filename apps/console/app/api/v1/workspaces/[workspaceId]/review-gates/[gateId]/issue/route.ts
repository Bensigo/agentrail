import { NextRequest, NextResponse } from "next/server";

/**
 * Legacy Review Gates issue publication is permanently quarantined. Its
 * findings/history remain readable, but it cannot bypass Acceptance Record,
 * exact-head, full-packet, and Jace approval custody by writing GitHub or
 * Linear directly.
 */
export async function POST(
  request: NextRequest,
  _context: { params: Promise<{ workspaceId: string; gateId: string }> },
) {
  void request.body?.cancel().catch(() => undefined);
  return NextResponse.json({
    error: "Legacy Review Gates issue publication is disabled",
    code: "LEGACY_REVIEW_GATE_ISSUE_PUBLICATION_DISABLED",
  }, {
    status: 410,
    headers: { "Cache-Control": "private, no-store" },
  });
}
