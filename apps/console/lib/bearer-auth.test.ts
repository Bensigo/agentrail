import { createHash } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  lookupApiKeyByHash: vi.fn(),
}));

import { requireAgentMcpBearer, requireBearer } from "./bearer-auth";
import { lookupApiKeyByHash } from "@agentrail/db-postgres";

const mockLookup = vi.mocked(lookupApiKeyByHash);

function req(authHeader?: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/claim", {
    headers: authHeader ? { Authorization: authHeader } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireBearer", () => {
  it("401s when there is no Authorization header", async () => {
    const result = await requireBearer(req());

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("401s when the Authorization header doesn't start with 'Bearer '", async () => {
    const result = await requireBearer(req("Basic abc123"));

    expect((result as NextResponse).status).toBe(401);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("401s when the bearer token is empty/whitespace-only", async () => {
    const result = await requireBearer(req("Bearer    "));

    expect((result as NextResponse).status).toBe(401);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("hashes the raw key with sha256 before looking it up (the raw key itself is never queried)", async () => {
    // lookupApiKeyByHash's inferred return type doesn't admit `null` even
    // though its real implementation returns `rows[0] ?? null` (a
    // pre-existing gap in this codebase's `rows[0] ?? null` idiom without
    // noUncheckedIndexedAccess — see connect-owner-elect-completion.test.ts's
    // identical note on getWorkspace). `as never` is the established
    // workaround.
    mockLookup.mockResolvedValue(null as never);
    const rawKey = "ar_test_raw_key_value";
    const expectedHash = createHash("sha256").update(rawKey).digest("hex");

    await requireBearer(req(`Bearer ${rawKey}`));

    expect(mockLookup).toHaveBeenCalledWith(expectedHash);
  });

  it("401s when lookupApiKeyByHash finds no row (revoked or unknown key)", async () => {
    mockLookup.mockResolvedValue(null as never);

    const result = await requireBearer(req("Bearer ar_unknown"));

    expect((result as NextResponse).status).toBe(401);
  });

  it("500s when lookupApiKeyByHash throws (a DB hiccup is not the caller's fault, but also not a silent pass)", async () => {
    mockLookup.mockRejectedValue(new Error("connection reset"));

    const result = await requireBearer(req("Bearer ar_whatever"));

    expect((result as NextResponse).status).toBe(500);
  });

  it("returns an empty scope list for a pre-scope self_hosted row", async () => {
    mockLookup.mockResolvedValue({
      id: "key-1",
      workspaceId: "ws-1",
      teamId: null,
      kind: "self_hosted",
    } as never);

    const result = await requireBearer(req("Bearer ar_valid"));

    expect(result).toEqual({
      apiKeyId: "key-1",
      workspaceId: "ws-1",
      teamId: null,
      kind: "self_hosted",
      scopes: [],
    });
  });

  it("returns kind: 'fleet' for a fleet-minted row (#1267 PR ①)", async () => {
    mockLookup.mockResolvedValue({
      id: "key-2",
      workspaceId: "ws-2",
      teamId: "team-1",
      kind: "fleet",
    } as never);

    const result = await requireBearer(req("Bearer ar_fleet_token"));

    expect(result).toEqual({
      apiKeyId: "key-2",
      workspaceId: "ws-2",
      teamId: "team-1",
      kind: "fleet",
      scopes: [],
    });
  });

  it("forbids a valid key of the wrong kind", async () => {
    mockLookup.mockResolvedValue({
      id: "key-3",
      workspaceId: "ws-3",
      teamId: null,
      kind: "self_hosted",
      scopes: [],
    } as never);

    const result = await requireBearer(req("Bearer ar_runner"), {
      kinds: ["agent_mcp"],
    });

    expect((result as NextResponse).status).toBe(403);
  });

  it("forbids an agent key missing a required scope", async () => {
    mockLookup.mockResolvedValue({
      id: "key-4",
      workspaceId: "ws-4",
      teamId: null,
      kind: "agent_mcp",
      scopes: ["acceptance:read"],
    } as never);

    const result = await requireBearer(req("Bearer ar_agent"), {
      kinds: ["agent_mcp"],
      scopes: ["acceptance:context:write"],
    });

    expect((result as NextResponse).status).toBe(403);
  });

  it("returns a scoped agent key when kind and scope requirements match", async () => {
    mockLookup.mockResolvedValue({
      id: "key-5",
      workspaceId: "ws-5",
      teamId: null,
      kind: "agent_mcp",
      scopes: ["acceptance:read", "acceptance:context:write"],
    } as never);

    const result = await requireBearer(req("Bearer ar_agent"), {
      kinds: ["agent_mcp"],
      scopes: ["acceptance:read"],
    });

    expect(result).toEqual({
      apiKeyId: "key-5",
      workspaceId: "ws-5",
      teamId: null,
      kind: "agent_mcp",
      scopes: ["acceptance:read", "acceptance:context:write"],
    });
  });

  it("does not accept an MCP key through the default runner bearer guard", async () => {
    mockLookup.mockResolvedValue({
      id: "key-6", workspaceId: "ws-6", teamId: null, kind: "agent_mcp", scopes: ["acceptance:read"],
    } as never);

    const result = await requireBearer(req("Bearer jace_mcp_only"));

    expect((result as NextResponse).status).toBe(403);
  });

  it("allows an MCP key only through the dedicated scope guard", async () => {
    mockLookup.mockResolvedValue({
      id: "key-7", workspaceId: "ws-7", teamId: null, kind: "agent_mcp", scopes: ["acceptance:read"],
    } as never);

    const result = await requireAgentMcpBearer(req("Bearer jace_mcp_read"), "acceptance:read");

    expect(result).toMatchObject({ apiKeyId: "key-7", workspaceId: "ws-7", kind: "agent_mcp" });
  });
});
