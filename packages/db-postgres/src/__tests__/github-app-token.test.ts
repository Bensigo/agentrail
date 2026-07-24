import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock("@agentrail/github-app", () => ({
  resolveGithubAppConfig: vi.fn(),
  mintInstallationToken: vi.fn(),
}));

import { db } from "../db.js";
import {
  resolveGithubAppConfig,
  mintInstallationToken,
} from "@agentrail/github-app";
import {
  getInstallationToken,
  consumeGithubInstallState,
} from "../queries/github-app-token.js";

const mockDb = vi.mocked(db);

function selectChain(finalValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(finalValue));
  return chain;
}
function updateChain(returned: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["update", "set", "where", "returning"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(returned));
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveGithubAppConfig).mockReturnValue({
    ok: true,
    appId: "12345",
    privateKey: "PEM",
    slug: "jace",
    botUserId: "98765",
  });
});

describe("getInstallationToken", () => {
  it("mints from the workspace's bound installation id", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777" }]) as never
    );
    vi.mocked(mintInstallationToken).mockResolvedValue({
      ok: true,
      token: "ghs_fresh",
      expiresAt: "2026-07-24T12:00:00Z",
    });
    expect(await getInstallationToken("ws-1")).toBe("ghs_fresh");
    expect(mintInstallationToken).toHaveBeenCalledWith(
      "777",
      expect.objectContaining({ appId: "12345" })
    );
  });

  it("returns null when no installation is bound", async () => {
    mockDb.select.mockReturnValue(selectChain([]) as never);
    expect(await getInstallationToken("ws-1")).toBeNull();
    expect(mintInstallationToken).not.toHaveBeenCalled();
  });

  it("returns null when the App env is unconfigured or the mint fails — never throws", async () => {
    vi.mocked(resolveGithubAppConfig).mockReturnValue({
      ok: false,
      missing: ["GITHUB_APP_ID"],
    });
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777" }]) as never
    );
    expect(await getInstallationToken("ws-1")).toBeNull();

    vi.mocked(resolveGithubAppConfig).mockReturnValue({
      ok: true, appId: "1", privateKey: "P", slug: "jace", botUserId: "9",
    });
    vi.mocked(mintInstallationToken).mockResolvedValue({
      ok: false,
      reason: "not_installed",
    });
    expect(await getInstallationToken("ws-1")).toBeNull();
  });
});

describe("consumeGithubInstallState", () => {
  it("resolves the workspace on a live token (atomic UPDATE … RETURNING)", async () => {
    mockDb.update.mockReturnValue(updateChain([{ id: "ws-1" }]) as never);
    expect(await consumeGithubInstallState("deadbeef")).toEqual({
      workspaceId: "ws-1",
    });
  });

  it("returns null for unknown/expired/reused state", async () => {
    mockDb.update.mockReturnValue(updateChain([]) as never);
    expect(await consumeGithubInstallState("deadbeef")).toBeNull();
  });
});
