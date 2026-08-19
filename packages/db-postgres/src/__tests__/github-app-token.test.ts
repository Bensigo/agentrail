import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock("@agentrail/github-app", () => ({
  resolveGithubAppConfig: vi.fn(),
  mintInstallationToken: vi.fn(),
  mintCorrectionCarrierInstallationToken: vi.fn(),
  mintRepositoryContentsReadInstallationToken: vi.fn(),
}));

import { db } from "../db.js";
import {
  resolveGithubAppConfig,
  mintInstallationToken,
  mintCorrectionCarrierInstallationToken,
  mintRepositoryContentsReadInstallationToken,
} from "@agentrail/github-app";
import {
  getInstallationToken,
  getGithubCorrectionCarrierCredential,
  getGithubDependencyBuilderCredential,
  getGithubDependencyObservationCredential,
  consumeGithubInstallState,
  getUserGithubIdentityById,
} from "../queries/github-app-token.js";
import { githubInstallationIdentitySha256 } from "../queries/change_records.js";

const mockDb = vi.mocked(db);
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

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

describe("getGithubCorrectionCarrierCredential", () => {
  it("derives the installation server-side and mints only an exact owner/repository grant", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777", accountLogin: "acme", accountType: "Organization" }]) as never
    );
    vi.mocked(mintCorrectionCarrierInstallationToken).mockResolvedValue({
      ok: true,
      token: "ghs_scoped",
      expiresAt: "2030-01-01T00:00:00Z",
      permissionBasis: {
        repository: "scoped_installation_token",
        issues: "write",
        pullRequests: "write",
      },
    });
    await expect(
      getGithubCorrectionCarrierCredential({ workspaceId: WORKSPACE_ID, repo: "acme/widgets" })
    ).resolves.toMatchObject({ ok: true, permissionBasis: { issues: "write", pullRequests: "write" } });
    expect(mintCorrectionCarrierInstallationToken).toHaveBeenCalledWith(
      { installationId: "777", owner: "acme", repo: "widgets" },
      expect.objectContaining({ appId: "12345" })
    );
  });

  it("refuses an owner mismatch before config or network minting", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777", accountLogin: "other-owner", accountType: "Organization" }]) as never
    );
    await expect(
      getGithubCorrectionCarrierCredential({ workspaceId: WORKSPACE_ID, repo: "acme/widgets" })
    ).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    });
    expect(mintCorrectionCarrierInstallationToken).not.toHaveBeenCalled();
  });

  it("preserves indeterminate transport state and never leaks a failed token", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777", accountLogin: "acme", accountType: "Organization" }]) as never
    );
    vi.mocked(mintCorrectionCarrierInstallationToken).mockResolvedValue({
      ok: false,
      kind: "indeterminate",
      reason: "github_unavailable",
    });
    const result = await getGithubCorrectionCarrierCredential({
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
    });
    expect(result).toEqual({ ok: false, kind: "indeterminate", reason: "github_unavailable" });
    expect(JSON.stringify(result)).not.toContain("ghs_");
  });

  it("keeps a workspace installation storage failure distinct from GitHub availability", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    await expect(
      getGithubCorrectionCarrierCredential({ workspaceId: WORKSPACE_ID, repo: "acme/widgets" })
    ).resolves.toEqual({ ok: false, kind: "indeterminate", reason: "storage_unavailable" });
    expect(mintCorrectionCarrierInstallationToken).not.toHaveBeenCalled();
  });

  it("refuses malformed or widened runtime input before any DB or mint call", async () => {
    for (const input of [
      null,
      { workspaceId: WORKSPACE_ID, repo: "acme/widgets", installationId: "777" },
      { workspaceId: "ws-1", repo: "acme/widgets" },
      { workspaceId: WORKSPACE_ID, repo: "acme/ghs_token\nsecret" },
      { workspaceId: WORKSPACE_ID, repo: "acme/widgets", token: "ghs_secret" },
    ]) {
      await expect(
        getGithubCorrectionCarrierCredential(input as never)
      ).resolves.toEqual({
        ok: false,
        kind: "unavailable",
        reason: "installation_or_permission_denied",
      });
    }
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mintCorrectionCarrierInstallationToken).not.toHaveBeenCalled();
  });
});

describe("getGithubDependencyBuilderCredential", () => {
  const expectedInstallationIdentitySha256 = githubInstallationIdentitySha256({
    workspaceId: WORKSPACE_ID,
    installationId: "777",
    accountLogin: "acme",
    accountType: "Organization",
  })!;

  it("mints only from the exact installation identity captured by the delivery reservation", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777", accountLogin: "acme", accountType: "Organization" }]) as never
    );
    vi.mocked(mintCorrectionCarrierInstallationToken).mockResolvedValue({
      ok: true,
      token: "ghs_scoped",
      expiresAt: "2030-01-01T00:00:00Z",
      permissionBasis: {
        repository: "scoped_installation_token",
        issues: "write",
        pullRequests: "write",
      },
    });

    await expect(getGithubDependencyBuilderCredential({
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
      expectedInstallationIdentitySha256,
    })).resolves.toMatchObject({ ok: true });
    expect(mintCorrectionCarrierInstallationToken).toHaveBeenCalledWith(
      { installationId: "777", owner: "acme", repo: "widgets" },
      expect.objectContaining({ appId: "12345" }),
    );
  });

  it("fails closed before minting when the workspace was rebound after reservation", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "888", accountLogin: "acme", accountType: "Organization" }]) as never
    );

    await expect(getGithubDependencyBuilderCredential({
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
      expectedInstallationIdentitySha256,
    })).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    });
    expect(resolveGithubAppConfig).not.toHaveBeenCalled();
    expect(mintCorrectionCarrierInstallationToken).not.toHaveBeenCalled();
  });
});

describe("getGithubDependencyObservationCredential", () => {
  const expectedInstallationIdentitySha256 = githubInstallationIdentitySha256({
    workspaceId: WORKSPACE_ID,
    installationId: "777",
    accountLogin: "acme",
    accountType: "Organization",
  })!;

  it("mints one repository-scoped contents-read token from the exact installation", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "777", accountLogin: "acme", accountType: "Organization" }]) as never,
    );
    vi.mocked(mintRepositoryContentsReadInstallationToken).mockResolvedValue({
      ok: true,
      token: "ghs_contents_read",
      expiresAt: "2030-01-01T00:00:00Z",
      permissionBasis: { repository: "scoped_installation_token", contents: "read" },
    } as never);

    await expect(getGithubDependencyObservationCredential({
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
      expectedInstallationIdentitySha256,
    })).resolves.toMatchObject({
      ok: true,
      permissionBasis: { repository: "scoped_installation_token", contents: "read" },
    });
    expect(mintRepositoryContentsReadInstallationToken).toHaveBeenCalledWith(
      { installationId: "777", owner: "acme", repo: "widgets" },
      expect.objectContaining({ appId: "12345" }),
    );
  });

  it("refuses an installation rebind before minting", async () => {
    mockDb.select.mockReturnValue(
      selectChain([{ installationId: "888", accountLogin: "acme", accountType: "Organization" }]) as never,
    );
    await expect(getGithubDependencyObservationCredential({
      workspaceId: WORKSPACE_ID,
      repo: "acme/widgets",
      expectedInstallationIdentitySha256,
    })).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      reason: "installation_or_permission_denied",
    });
    expect(mintRepositoryContentsReadInstallationToken).not.toHaveBeenCalled();
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

describe("getUserGithubIdentityById", () => {
  it("returns { accessToken, providerAccountId } for (userId, provider='github')", async () => {
    mockDb.select.mockReturnValue(
      selectChain([
        { accessToken: "gho_login_token", providerAccountId: "555" },
      ]) as never
    );
    expect(await getUserGithubIdentityById("user-1")).toEqual({
      accessToken: "gho_login_token",
      providerAccountId: "555",
    });
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("returns null when the user has no linked GitHub account", async () => {
    mockDb.select.mockReturnValue(selectChain([]) as never);
    expect(await getUserGithubIdentityById("user-2")).toBeNull();
  });

  it("returns null when the stored access_token is null", async () => {
    mockDb.select.mockReturnValue(
      selectChain([
        { accessToken: null, providerAccountId: "555" },
      ]) as never
    );
    expect(await getUserGithubIdentityById("user-3")).toBeNull();
  });

  it("returns null when the stored provider_account_id is null", async () => {
    mockDb.select.mockReturnValue(
      selectChain([
        { accessToken: "gho_login_token", providerAccountId: null },
      ]) as never
    );
    expect(await getUserGithubIdentityById("user-4")).toBeNull();
  });
});
