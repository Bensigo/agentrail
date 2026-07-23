import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  getConnector: vi.fn(),
  enqueueLinearIssue: vi.fn(),
}));

vi.mock("../../../../../../../lib/alignment-reconciler", () => ({
  postAlignmentBrief: vi.fn(),
  reconcileAlignmentBriefs: vi.fn(),
}));

import { POST } from "./route";
import { getConnector, enqueueLinearIssue } from "@agentrail/db-postgres";
import {
  postAlignmentBrief,
  reconcileAlignmentBriefs,
} from "../../../../../../../lib/alignment-reconciler";

const mockGetConnector = vi.mocked(getConnector);
const mockEnqueue = vi.mocked(enqueueLinearIssue);
const mockPostBrief = vi.mocked(postAlignmentBrief);
const mockReconcile = vi.mocked(reconcileAlignmentBriefs);

const SECRET = "lin_wh_secret_test_value";
const ORIGINAL_ENV = process.env["LINEAR_WEBHOOK_SECRET"];

function sign(raw: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function issuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "create",
    type: "Issue",
    webhookTimestamp: Date.now(),
    data: {
      id: "lin-abc",
      number: 7,
      title: "Add dark mode",
      description: "## Acceptance criteria\n- [ ] Toggle in settings\n",
      labels: [{ id: "lbl-1", name: "ready-for-agent" }],
    },
    ...overrides,
  };
}

function makeRequest(
  payload: Record<string, unknown>,
  opts: {
    signature?: string | null; // undefined -> sign correctly; null -> omit header
    secret?: string; // secret used to sign
    timestampHeader?: string | null; // undefined -> derive from body; null -> omit
  } = {}
): NextRequest {
  const raw = JSON.stringify(payload);
  const sig =
    opts.signature === undefined ? sign(raw, opts.secret ?? SECRET) : opts.signature;
  const headers = new Headers({ "content-type": "application/json" });
  if (sig !== null) headers.set("linear-signature", sig);
  if (opts.timestampHeader !== null) {
    const ts =
      opts.timestampHeader ?? String((payload["webhookTimestamp"] as number) ?? Date.now());
    headers.set("linear-timestamp", ts);
  }
  return new NextRequest(
    "http://localhost/api/v1/connectors/linear/webhook/ws-1",
    { method: "POST", headers, body: raw }
  );
}

function call(req: NextRequest) {
  return POST(req, { params: Promise.resolve({ workspaceId: "ws-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["LINEAR_WEBHOOK_SECRET"];
  mockGetConnector.mockResolvedValue({
    provider: "linear",
    enabled: true,
    config: { webhookSecret: SECRET, triggerLabel: "ready-for-agent" },
    hasSecret: true,
    updatedAt: null,
  } as never);
  mockEnqueue.mockResolvedValue({
    enqueued: true,
    id: "97f83370-bf90-5338-ab6b-2b4a985b3e88",
    state: "queued",
    blockedBy: [],
  } as never);
  mockReconcile.mockResolvedValue([] as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env["LINEAR_WEBHOOK_SECRET"];
  else process.env["LINEAR_WEBHOOK_SECRET"] = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("POST linear/webhook — signature verification (verify-before-acting)", () => {
  it("enqueues on a valid signature, with the Linear id+number carried into the external id", async () => {
    const res = await call(makeRequest(issuePayload()));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      issueId: "lin-abc",
      number: 7,
      title: "Add dark mode",
      body: "## Acceptance criteria\n- [ ] Toggle in settings\n",
    });
    expect(body).toEqual({
      matched: true,
      enqueued: 1,
      id: "97f83370-bf90-5338-ab6b-2b4a985b3e88",
    });
  });

  it("rejects a tampered/invalid signature with 401 and NEVER enqueues", async () => {
    const res = await call(makeRequest(issuePayload(), { signature: "deadbeef" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid signature");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a signature made with the WRONG secret (401)", async () => {
    const res = await call(
      makeRequest(issuePayload(), { secret: "some-other-secret" })
    );
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a replayed delivery — a valid signature but a stale timestamp (401)", async () => {
    // Body signed correctly, but its webhookTimestamp (and header) is >60s old.
    const stale = Date.now() - 120_000;
    const payload = issuePayload({ webhookTimestamp: stale });
    const res = await call(makeRequest(payload)); // header derives the stale ts
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/stale timestamp/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects when no signing secret is configured (401) — never acts unverified", async () => {
    mockGetConnector.mockResolvedValue({
      provider: "linear",
      enabled: true,
      config: { triggerLabel: "ready-for-agent" }, // no webhookSecret
      hasSecret: true,
      updatedAt: null,
    } as never);
    const res = await call(makeRequest(issuePayload()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/secret not configured/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header (401)", async () => {
    const res = await call(makeRequest(issuePayload(), { signature: null }));
    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("POST linear/webhook — routing + trigger gating", () => {
  it("no-ops (200 ignored) when the linear connector is missing/disabled", async () => {
    mockGetConnector.mockResolvedValue(null as never);
    const res = await call(makeRequest(issuePayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: "linear connector not enabled" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a non-Issue event type", async () => {
    const res = await call(makeRequest(issuePayload({ type: "Comment" })));
    expect(await res.json()).toEqual({ ignored: "Comment" });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("ignores a non-trigger action (remove)", async () => {
    const res = await call(makeRequest(issuePayload({ action: "remove" })));
    const body = await res.json();
    expect(body.matched).toBe(false);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("reports matched:false when the trigger label is absent", async () => {
    const payload = issuePayload();
    (payload["data"] as Record<string, unknown>)["labels"] = [{ name: "bug" }];
    const res = await call(makeRequest(payload));
    expect(await res.json()).toEqual({
      matched: false,
      reason: "trigger label not on issue",
    });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("passes an AC-gate rejection through unchanged (enqueued:0)", async () => {
    mockEnqueue.mockResolvedValue({
      enqueued: false,
      reason: "no 'Acceptance criteria' section in the issue body",
    } as never);
    const res = await call(makeRequest(issuePayload()));
    expect(await res.json()).toEqual({
      matched: true,
      enqueued: 0,
      reason: "no 'Acceptance criteria' section in the issue body",
    });
    expect(mockPostBrief).not.toHaveBeenCalled();
  });
});

describe("POST linear/webhook — alignment parity (AC2)", () => {
  it("posts an alignment brief for an awaiting-alignment park, with NO repoFullName/number (linear has none)", async () => {
    mockEnqueue.mockResolvedValue({
      enqueued: true,
      id: "entry-linear-1",
      state: "parked",
      blockedBy: [],
      parkedFor: "awaiting_alignment",
    } as never);
    mockPostBrief.mockResolvedValue("posted" as never);

    const res = await call(makeRequest(issuePayload()));
    const body = await res.json();

    expect(mockPostBrief).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      queueEntryId: "entry-linear-1",
      title: "Add dark mode",
      body: "## Acceptance criteria\n- [ ] Toggle in settings\n",
    });
    expect(body).toEqual({
      matched: true,
      enqueued: 1,
      id: "entry-linear-1",
      alignmentBrief: "posted",
    });
  });

  it("runs the workspace reconciler sweep after a successful admit (recovers heartbeat-admitted linear rows)", async () => {
    await call(makeRequest(issuePayload()));
    expect(mockReconcile).toHaveBeenCalledWith("ws-1", 5);
  });
});
