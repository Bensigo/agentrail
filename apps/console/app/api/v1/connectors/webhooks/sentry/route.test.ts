import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";

// This route's only DB touches are the two W3-T5 helpers — mock just those,
// keep the rest of the barrel real (same pattern
// `github/webhook/route.per-workspace-secret.test.ts` establishes).
vi.mock("@agentrail/db-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentrail/db-postgres")>();
  return {
    ...actual,
    findConnectorsBySentryInstallationId: vi.fn(),
    clearSentryConnectorForInstallation: vi.fn(),
  };
});

import { POST } from "./route";
import { findConnectorsBySentryInstallationId, clearSentryConnectorForInstallation } from "@agentrail/db-postgres";

const mockFind = vi.mocked(findConnectorsBySentryInstallationId);
const mockClear = vi.mocked(clearSentryConnectorForInstallation);

const SECRET = "w3t5-route-test-client-secret";
const ROUTE_URL = "http://localhost/api/v1/connectors/webhooks/sentry";
const SIGNATURE_HEADER = "sentry-hook-signature";
const RESOURCE_HEADER = "sentry-hook-resource";

/** Sentry's own documented HMAC-SHA256 hex digest, over the raw body text. */
function sign(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("hex");
}

function req(raw: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

/** A validly-signed request's headers for a given raw body — the common case. */
function signedHeaders(raw: string, resource = "installation"): Record<string, string> {
  return { [SIGNATURE_HEADER]: sign(raw, SECRET), [RESOURCE_HEADER]: resource };
}

function installationDeletedBody(installationId: string): string {
  return JSON.stringify({
    action: "deleted",
    actor: { id: 1, name: "Some Owner", type: "user" },
    data: {
      installation: {
        status: "installed",
        organization: { slug: "acme" },
        app: { uuid: "app-uuid-1", slug: "agentrail" },
        code: "code-abc",
        uuid: installationId,
      },
    },
    installation: { uuid: installationId },
  });
}

function installationCreatedBody(installationId: string): string {
  const parsed = JSON.parse(installationDeletedBody(installationId)) as Record<string, unknown>;
  parsed.action = "created";
  return JSON.stringify(parsed);
}

const ORIGINAL_SECRET = process.env["SENTRY_OAUTH_CLIENT_SECRET"];

beforeEach(() => {
  vi.clearAllMocks();
  process.env["SENTRY_OAUTH_CLIENT_SECRET"] = SECRET;
  mockFind.mockResolvedValue([]);
  mockClear.mockResolvedValue(true);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env["SENTRY_OAUTH_CLIENT_SECRET"];
  } else {
    process.env["SENTRY_OAUTH_CLIENT_SECRET"] = ORIGINAL_SECRET;
  }
});

describe("POST /api/v1/connectors/webhooks/sentry — env gate", () => {
  it("returns 503 with a fixed body when SENTRY_OAUTH_CLIENT_SECRET is unset — never a signature bypass", async () => {
    delete process.env["SENTRY_OAUTH_CLIENT_SECRET"];
    // Deliberately sending NO signature at all -- an unconfigured deployment
    // must 503 before ever reaching signature verification, not fall
    // through to "no secret -> skip verification".
    const res = await POST(req(installationDeletedBody("install-1")));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sentry webhook not configured" });
    expect(mockFind).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/webhooks/sentry — signature verification", () => {
  it("accepts a delivery with a valid signature", async () => {
    const raw = installationCreatedBody("install-1");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, status: "ignored" });
  });

  it("rejects an INVALID signature with 401, without echoing the bad header value or the raw body in logs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = installationDeletedBody("install-ZZPROBE9-marker");
    const res = await POST(req(raw, { [SIGNATURE_HEADER]: "not-a-real-signature", [RESOURCE_HEADER]: "installation" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(mockFind).not.toHaveBeenCalled();

    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("not-a-real-signature");
    expect(logged).not.toContain("install-ZZPROBE9-marker");
    errSpy.mockRestore();
  });

  it("rejects a MISSING signature with 401", async () => {
    const raw = installationDeletedBody("install-1");
    const res = await POST(req(raw, { [RESOURCE_HEADER]: "installation" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("rejects a signature computed under a DIFFERENT secret", async () => {
    const raw = installationDeletedBody("install-1");
    const res = await POST(
      req(raw, { [SIGNATURE_HEADER]: sign(raw, "some-other-secret"), [RESOURCE_HEADER]: "installation" })
    );

    expect(res.status).toBe(401);
  });

  it("raw-body signature fidelity: validates over the EXACT raw bytes, including multi-byte unicode", async () => {
    const raw = JSON.stringify({
      action: "created",
      actor: { id: 1, name: "café ☃ ünïcödé тест", type: "user" },
      installation: { uuid: "install-unicode-1" },
    });
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
  });

  it("raw-body signature fidelity: a signature over a re-serialized (whitespace-differing) copy of the SAME JSON value does NOT validate against the original wire bytes", async () => {
    const raw = JSON.stringify({ action: "created", installation: { uuid: "install-1" } });
    const reserialized = JSON.stringify(JSON.parse(raw), null, 2);
    expect(reserialized).not.toBe(raw);

    const res = await POST(
      req(raw, { [SIGNATURE_HEADER]: sign(reserialized, SECRET), [RESOURCE_HEADER]: "installation" })
    );

    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/connectors/webhooks/sentry — malformed body", () => {
  it("returns 400 (never 500) for a validly-signed body that isn't valid JSON, without leaking its content into logs", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = "{not json, marker ZZPROBE10";
    const res = await POST(req(raw, { [SIGNATURE_HEADER]: sign(raw, SECRET) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
    expect(mockFind).not.toHaveBeenCalled();

    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("ZZPROBE10");
    errSpy.mockRestore();
  });
});

describe("POST /api/v1/connectors/webhooks/sentry — installation.created and other verified events", () => {
  it("installation.created is a 200 no-op — never touches the connector lookup", async () => {
    const raw = installationCreatedBody("install-1");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, status: "ignored" });
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("a different resource entirely is a 200 no-op even when its own action happens to be 'deleted' (action vocabulary is resource-scoped)", async () => {
    const raw = JSON.stringify({ action: "deleted", installation: { uuid: "install-1" } });
    const res = await POST(req(raw, signedHeaders(raw, "issue")));

    expect(res.status).toBe(200);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("a missing Sentry-Hook-Resource header on an action:deleted body is a 200 no-op, never mistaken for installation.deleted", async () => {
    const raw = installationDeletedBody("install-1");
    const res = await POST(req(raw, { [SIGNATURE_HEADER]: sign(raw, SECRET) }));

    expect(res.status).toBe(200);
    expect(mockFind).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/connectors/webhooks/sentry — installation.deleted", () => {
  it("clears the matching workspace's sentry connector and reports the count", async () => {
    mockFind.mockResolvedValue([{ workspaceId: "ws-A" }]);
    mockClear.mockResolvedValue(true);

    const raw = installationDeletedBody("install-A");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, status: "installation_deleted", cleared: 1 });
    expect(mockFind).toHaveBeenCalledWith("install-A");
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledWith("ws-A", "install-A");
  });

  it("clears ONLY the workspace whose installationId matches — a second, differently-installationId'd workspace is never touched (two workspaces, same-shaped config, different installationIds)", async () => {
    // Simulates two real workspaces with same-shaped sentry connector
    // config but DIFFERENT installationIds. The scoping itself is a
    // db-postgres-level guarantee (connectors.test.ts proves the WHERE
    // clause); this proves the ROUTE's own per-match loop never reaches
    // for a workspace the lookup didn't return.
    mockFind.mockImplementation(async (installationId: string) =>
      installationId === "install-A" ? [{ workspaceId: "ws-A" }] : []
    );
    mockClear.mockResolvedValue(true);

    const raw = installationDeletedBody("install-A");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockClear).toHaveBeenCalledWith("ws-A", "install-A");
    const clearedWorkspaceIds = mockClear.mock.calls.map((c) => c[0]);
    expect(clearedWorkspaceIds).not.toContain("ws-B");
  });

  it("an unknown installationId (zero matches) is a 200 no-op — never calls clear", async () => {
    mockFind.mockResolvedValue([]);

    const raw = installationDeletedBody("install-unknown");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, status: "installation_deleted", cleared: 0 });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("clears EVERY match when, defensively, more than one workspace resolves for the same installationId", async () => {
    mockFind.mockResolvedValue([{ workspaceId: "ws-A" }, { workspaceId: "ws-B" }]);
    mockClear.mockResolvedValue(true);

    const raw = installationDeletedBody("install-shared");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(await res.json()).toEqual({ received: true, status: "installation_deleted", cleared: 2 });
    expect(mockClear).toHaveBeenCalledTimes(2);
    expect(mockClear).toHaveBeenCalledWith("ws-A", "install-shared");
    expect(mockClear).toHaveBeenCalledWith("ws-B", "install-shared");
  });

  it("a match clearSentryConnectorForInstallation reports as NOT cleared (a reconnect race) is excluded from the count, never thrown", async () => {
    mockFind.mockResolvedValue([{ workspaceId: "ws-A" }]);
    mockClear.mockResolvedValue(false);

    const raw = installationDeletedBody("install-A");
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, status: "installation_deleted", cleared: 0 });
  });

  it("a well-signed installation.deleted body missing its own installation.uuid is a 200 no-op, never a crash", async () => {
    const raw = JSON.stringify({ action: "deleted" });
    const res = await POST(req(raw, signedHeaders(raw)));

    expect(res.status).toBe(200);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
