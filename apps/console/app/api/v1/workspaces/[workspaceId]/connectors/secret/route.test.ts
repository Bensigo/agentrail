import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/auth", () => ({ auth: vi.fn() }));
vi.mock("@agentrail/db-postgres", () => ({
  getWorkspaceMembership: vi.fn(),
  setConnectorSecret: vi.fn(),
}));

import { auth } from "@agentrail/auth";
import { getWorkspaceMembership, setConnectorSecret } from "@agentrail/db-postgres";
import { PUT } from "./route";

const WS = "00000000-0000-0000-0000-000000000001";
const USER = "user-1";

function params() {
  return Promise.resolve({ workspaceId: WS });
}

function putReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/workspaces/${WS}/connectors/secret`,
    { method: "PUT", body: JSON.stringify(body) }
  );
}

beforeEach(() => {
  vi.mocked(auth).mockReset();
  vi.mocked(getWorkspaceMembership).mockReset();
  vi.mocked(setConnectorSecret).mockReset();
  vi.mocked(auth).mockResolvedValue({ user: { id: USER } } as never);
  vi.mocked(getWorkspaceMembership).mockResolvedValue({ role: "owner" } as never);
});

/**
 * Allowlist behavior (Gateway → Channels cutover): this route manages the
 * MCP tools' credentials only (linear/figma/context7). Discord, Slack and
 * Telegram used to be here too (a bot token / webhook secret); post-cutover
 * they are Jace-native chat channels with nothing to paste — connecting is
 * DMing the shared bot, recorded as a `chat_identities` row elsewhere. A PUT
 * for any of the three (or any other non-allowlisted provider) must fail with
 * the route's existing invalid-provider error shape, and never touch storage.
 */
describe("PUT /connectors/secret — allowlist (Channels cutover)", () => {
  it("rejects telegram — no longer credential-based; connects via a linked chat identity instead", async () => {
    const res = await PUT(
      putReq({ provider: "telegram", secret: "123456789:AAH" + "a".repeat(32) }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "provider must be one of linear, figma, context7",
    });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("rejects slack — no longer credential-based", async () => {
    const res = await PUT(
      putReq({
        provider: "slack",
        secret: "https://hooks.slack.com/services/T0/B0/abcDEF",
      }),
      { params: params() }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "provider must be one of linear, figma, context7",
    });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });

  it("rejects discord too — it never had a credential here, and its dedicated webhook route is gone", async () => {
    const res = await PUT(putReq({ provider: "discord", secret: "x" }), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "provider must be one of linear, figma, context7",
    });
    expect(setConnectorSecret).not.toHaveBeenCalled();
  });
});
