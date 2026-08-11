import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@agentrail/db-postgres", () => ({
  recordAcceptanceDependencyObservation: vi.fn(),
  AcceptanceDependencyObservationConflictError: class AcceptanceDependencyObservationConflictError extends Error {},
  AcceptanceDependencyObservationInvalidEvidenceError: class AcceptanceDependencyObservationInvalidEvidenceError extends Error {},
}));

import {
  AcceptanceDependencyObservationConflictError,
  AcceptanceDependencyObservationInvalidEvidenceError,
  recordAcceptanceDependencyObservation,
} from "@agentrail/db-postgres";
import { POST } from "./route";

const SECRET = "jace-shared-secret-abc123";
const ORIGINAL_SECRET = process.env.JACE_CONSOLE_TOKEN;
const OBSERVED_AT = new Date("2026-08-11T08:00:00.000Z");
const VALID = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  recordId: "22222222-2222-4222-8222-222222222222",
  compiledPackId: "33333333-3333-4333-8333-333333333333",
  candidate: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    package: "@acme/widget",
    dependencyKind: "dependencies",
    specifier: "^1.2.0",
    currentVersion: "1.2.3",
    targetVersion: "1.3.0",
  },
  runtime: { identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" }, disposition: "safe", version: "22.14.0", evidenceSha256: "a".repeat(64) },
  packageManager: {
    disposition: "safe",
    name: "pnpm",
    version: "10.14.0",
    profile: "pnpm_lockfile_only_v1",
    updateArgv: ["pnpm", "update", "@acme/widget@1.3.0", "--lockfile-only", "--ignore-scripts"],
    evidenceSha256: "b".repeat(64),
  },
  manifest: { path: "packages/widget/package.json", blobSha: "c".repeat(40) },
  lockfile: {
    disposition: "present",
    path: "pnpm-lock.yaml",
    blobSha: "d".repeat(40),
    evidenceSha256: "e".repeat(64),
  },
  baseline: { headSha: "f".repeat(40) },
  security: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "clear",
    provider: "osv",
    reference: "osv:npm:@acme/widget@1.3.0",
    reportSha256: "1".repeat(64),
  },
};

const BINDING = {
  workspaceId: VALID.workspaceId,
  recordId: VALID.recordId,
  repo: "acme/widget",
  prNumber: 42,
  headSha: VALID.baseline.headSha,
  headCycleId: "44444444-4444-4444-8444-444444444444",
  authorityGeneration: 3,
  reviewJobId: "44444444-4444-4444-8444-444444444444",
  acceptanceContract: { id: "55555555-5555-4555-8555-555555555555", version: 2, sha256: "2".repeat(64) },
  compiledPack: {
    id: VALID.compiledPackId,
    sha256: "3".repeat(64),
    sourceSnapshotId: "66666666-6666-4666-8666-666666666666",
    sourceCustodyIdentitySha256: "4".repeat(64),
    compilerVersion: "acceptance-context-pack-compiler-v2",
    policyVersion: "acceptance-context-pack-policy-v2",
    exactHeadDependencyTreeProofsSha256: "5".repeat(64),
  },
};

function dbResult(kind: "recorded" | "replayed", status = "observed", reasons: string[] = []) {
  return {
    kind,
    binding: BINDING,
    observation: {
      eventId: "77777777-7777-4777-8777-777777777777",
      eventKey: "dependency-observation:key",
      status,
      reasons,
      candidateFingerprint: `sha256:${"6".repeat(64)}`,
      candidate: VALID.candidate,
      runtime: VALID.runtime,
      packageManager: VALID.packageManager,
      manifest: VALID.manifest,
      lockfile: VALID.lockfile,
      baseline: VALID.baseline,
      security: VALID.security,
      observedAt: OBSERVED_AT,
    },
  };
}

function request(body: unknown, options?: { auth?: boolean; contentType?: string }): NextRequest {
  return new NextRequest("http://localhost/api/v1/runner/acceptance-dependency-observations", {
    method: "POST",
    headers: {
      "content-type": options?.contentType ?? "application/json",
      ...(options?.auth === false ? {} : { authorization: `Bearer ${SECRET}` }),
    },
    body: JSON.stringify(body),
  });
}

function npmRequestBody() {
  const value = structuredClone(VALID);
  const identity = { ecosystem: "node", manager: "npm", profile: "npm_package_lock_only_v1" };
  value.candidate.identity = identity;
  value.runtime.identity = identity;
  value.packageManager = {
    ...value.packageManager,
    name: "npm",
    profile: "npm_package_lock_only_v1",
    updateArgv: [
      "npm", "install", "@acme/widget@1.3.0", "--package-lock-only",
      "--ignore-scripts", "--no-audit", "--save-prod",
    ],
  };
  value.manifest.path = "package.json";
  value.lockfile.path = "package-lock.json";
  value.security.identity = identity;
  return value;
}

function yarnRequestBody() {
  const value = structuredClone(VALID);
  const identity = {
    ecosystem: "node",
    manager: "yarn",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
  };
  value.candidate.identity = identity;
  value.runtime.identity = identity;
  value.packageManager = {
    ...value.packageManager,
    name: "yarn",
    version: "4.9.2",
    profile: "yarn_berry_v4_root_lockfile_only_v1",
    updateArgv: ["yarn", "add", "@acme/widget@1.3.0", "--mode=update-lockfile"],
  };
  value.manifest.path = "package.json";
  value.lockfile.path = "yarn.lock";
  value.security.identity = identity;
  return value;
}

function uvRequestBody() {
  const value = structuredClone(VALID);
  const identity = {
    ecosystem: "python",
    manager: "uv",
    profile: "uv_project_lockfile_only_v1",
  };
  value.candidate = {
    ...value.candidate,
    identity,
    package: "typing-extensions",
    dependencyKind: "dependencies",
    specifier: ">=4.10.0",
    currentVersion: "4.11.0",
    targetVersion: "4.12.2",
  };
  value.runtime = { ...value.runtime, identity, version: "3.12.8" };
  value.packageManager = {
    ...value.packageManager,
    name: "uv",
    version: "0.12.1",
    profile: "uv_project_lockfile_only_v1",
    updateArgv: [
      "uv", "lock", "--no-cache", "--no-config", "--no-python-downloads",
      "--no-sources", "--no-build", "--upgrade-package", "typing-extensions==4.12.2",
    ],
  };
  value.manifest = { ...value.manifest, path: "pyproject.toml" };
  value.lockfile = { ...value.lockfile, path: "uv.lock" };
  value.security = {
    ...value.security,
    identity,
    reference: "osv:PyPI:typing-extensions@4.12.2",
  };
  return value;
}

function goRequestBody(
  module = "github.com/acme/widget",
  currentVersion = "v1.2.3",
  targetVersion = "v1.3.0",
) {
  const value = structuredClone(VALID);
  const identity = {
    ecosystem: "go",
    manager: "go-modules",
    profile: "go_1_26_root_mod_sum_public_proxy_v1",
  };
  value.candidate = {
    ...value.candidate,
    identity,
    package: module,
    dependencyKind: "dependencies",
    specifier: currentVersion,
    currentVersion,
    targetVersion,
  };
  value.runtime = { ...value.runtime, identity, version: "1.26.1" };
  value.packageManager = {
    ...value.packageManager,
    name: "go",
    version: "1.26.1",
    profile: "go_1_26_root_mod_sum_public_proxy_v1",
    updateArgv: ["go", "get", "-mod=mod", `${module}@${targetVersion}`],
  };
  value.manifest = { ...value.manifest, path: "go.mod" };
  value.lockfile = { ...value.lockfile, path: "go.sum" };
  value.security = {
    ...value.security,
    identity,
    reference: `osv:Go:${module}@${targetVersion.slice(1)}`,
  };
  return value;
}

function historicalNpmReplayBody() {
  const value = npmRequestBody();
  Object.assign(value.candidate, {
    specifier: "npm:@acme/real-widget@^1.2.0",
    currentVersion: "release-1",
    targetVersion: "release-2",
  });
  value.runtime.version = "node-current";
  Object.assign(value.packageManager, {
    version: "npm-current",
    updateArgv: ["npm", "update", "@acme/widget"],
  });
  value.manifest.path = "legacy/package.json";
  value.lockfile.path = "legacy/package-lock.json";
  Object.assign(value.security, {
    provider: "legacy-provider",
    reference: "opaque:historical-query",
  });
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JACE_CONSOLE_TOKEN = SECRET;
  vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(dbResult("recorded") as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.JACE_CONSOLE_TOKEN;
  else process.env.JACE_CONSOLE_TOKEN = ORIGINAL_SECRET;
});

describe("POST /api/v1/runner/acceptance-dependency-observations", () => {
  it("authenticates before reading or recording the body", async () => {
    const response = await POST(request({ arbitrary: true }, { auth: false }));
    expect(response.status).toBe(401);
    expect(recordAcceptanceDependencyObservation).not.toHaveBeenCalled();
  });

  it("records one exact normalized observation without echoing evidence or claiming approval", async () => {
    const raw = structuredClone(VALID);
    raw.workspaceId = raw.workspaceId.toUpperCase();
    raw.baseline.headSha = raw.baseline.headSha.toUpperCase();
    const response = await POST(request(raw));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledTimes(1);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(VALID);
    const json = await response.json();
    expect(json).toEqual({
      kind: "recorded",
      status: "observed",
      reasons: [],
      eventId: "77777777-7777-4777-8777-777777777777",
      candidateFingerprint: `sha256:${"6".repeat(64)}`,
      observedAt: OBSERVED_AT.toISOString(),
    });
    expect(JSON.stringify(json)).not.toMatch(/approv|workspaceId|headSha|updateArgv|security/iu);
  });

  it("passes one exact npm package-lock-only observation to the same DB authority", async () => {
    const npm = npmRequestBody();
    const response = await POST(request(npm));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(npm);
    expect(JSON.stringify(await response.json())).not.toMatch(/install|save-prod|security|approv/iu);
  });

  it("passes one exact Yarn 4 lockfile-only observation without caller configuration authority", async () => {
    const yarn = yarnRequestBody();
    const response = await POST(request(yarn));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(yarn);
    expect(yarn).not.toHaveProperty("yarnConfiguration");
    expect(JSON.stringify(await response.json())).not.toMatch(/yarnrc|update-lockfile|security|approv/iu);
  });

  it("passes one exact uv lockfile-only observation to the same DB authority", async () => {
    const uv = uvRequestBody();
    const response = await POST(request(uv));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(uv);
    expect(JSON.stringify(await response.json())).not.toMatch(/upgrade-package|security|approv|execute/iu);
  });

  it("passes one exact Go 1.26 module observation to the same DB authority", async () => {
    const go = goRequestBody("gopkg.in/yaml.v3", "v3.0.0", "v3.0.1");
    const response = await POST(request(go));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(go);
    expect(go.candidate.identity.manager).toBe("go-modules");
    expect(go.packageManager.name).toBe("go");
    expect(JSON.stringify(await response.json()))
      .not.toMatch(/go get|-mod|security|approv|execute|deliver/iu);
  });

  it("passes bounded Go command drift once so the DB can persist refusal truth", async () => {
    const go = goRequestBody();
    go.packageManager.updateArgv = ["go", "get", "github.com/acme/widget@v1.3.0"];
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("recorded", "refused_unsafe_runtime", ["unsafe_package_manager_argv"]) as never
    );

    const response = await POST(request(go));

    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(go);
    await expect(response.json()).resolves.toMatchObject({
      status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager_argv"],
    });
  });

  it("lets bounded formerly unsupported Go evidence reach only the exact DB replay seam", async () => {
    const historical = goRequestBody("gopkg.in/yaml/v3", "v3.0.0", "v3.0.1");
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("replayed", "refused_unsupported_profile", ["unsupported_manager_profile"]) as never
    );

    const response = await POST(request(historical));

    expect(response.status).toBe(200);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(historical);
    await expect(response.json()).resolves.toMatchObject({
      kind: "replayed",
      status: "refused_unsupported_profile",
      reasons: ["unsupported_manager_profile"],
    });
  });

  it("maps a new or altered historical Go candidate to sanitized invalid evidence", async () => {
    vi.mocked(recordAcceptanceDependencyObservation).mockRejectedValue(
      new AcceptanceDependencyObservationInvalidEvidenceError()
    );

    const response = await POST(request(
      goRequestBody("gopkg.in/yaml/v3", "v3.0.0", "v3.0.1")
    ));

    expect(response.status).toBe(400);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({ error: "Invalid dependency observation" });
  });

  it("lets bounded formerly-supported uv evidence reach only the exact DB replay seam", async () => {
    const historical = uvRequestBody();
    historical.packageManager.version = "uv-current";
    historical.candidate.specifier = "~=4.10";
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("replayed", "refused_unsupported_profile", ["unsupported_manager_profile"]) as never
    );

    const response = await POST(request(historical));

    expect(response.status).toBe(200);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(historical);
    await expect(response.json()).resolves.toMatchObject({
      kind: "replayed",
      status: "refused_unsupported_profile",
      reasons: ["unsupported_manager_profile"],
    });
  });

  it("lets a bounded former Yarn profile reach only the exact DB replay seam", async () => {
    const historical = yarnRequestBody();
    historical.packageManager.version = "yarn-current";
    historical.candidate.specifier = "workspace:^";
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("replayed", "refused_unsupported_profile", ["unsupported_manager_profile"]) as never
    );

    const response = await POST(request(historical));

    expect(response.status).toBe(200);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(historical);
    await expect(response.json()).resolves.toMatchObject({
      kind: "replayed",
      status: "refused_unsupported_profile",
      reasons: ["unsupported_manager_profile"],
    });
  });

  it("passes bounded npm command drift once so the DB can persist refusal truth", async () => {
    const npm = npmRequestBody();
    npm.packageManager.updateArgv = [
      "npm", "install", "@acme/widget@1.3.0", "--package-lock-only",
      "--ignore-scripts", "--save-prod",
    ];
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("recorded", "refused_unsafe_runtime", ["unsafe_package_manager_argv"]) as never
    );
    const response = await POST(request(npm));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(npm);
    await expect(response.json()).resolves.toMatchObject({
      status: "refused_unsafe_runtime", reasons: ["unsafe_package_manager_argv"],
    });
  });

  it("lets an old bounded unsupported npm body reach only the exact DB replay seam", async () => {
    const historical = historicalNpmReplayBody();
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("replayed", "refused_unsupported_profile", ["unsupported_manager_profile"]) as never
    );

    const response = await POST(request(historical));

    expect(response.status).toBe(200);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(historical);
    await expect(response.json()).resolves.toMatchObject({
      kind: "replayed",
      status: "refused_unsupported_profile",
      reasons: ["unsupported_manager_profile"],
    });
  });

  it("maps a new or altered historical npm candidate to sanitized invalid evidence", async () => {
    vi.mocked(recordAcceptanceDependencyObservation).mockRejectedValue(
      new AcceptanceDependencyObservationInvalidEvidenceError()
    );

    const response = await POST(request(historicalNpmReplayBody()));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid dependency observation" });
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledOnce();
  });

  it("passes bounded unsafe argv evidence to DB once and returns the refusal truth", async () => {
    const raw = structuredClone(VALID);
    raw.packageManager.updateArgv = ["pnpm", "exec", "postinstall"];
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("recorded", "refused_unsafe_runtime", ["unsafe_package_manager_argv"]) as never
    );
    const response = await POST(request(raw));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledTimes(1);
    expect((await response.json()).status).toBe("refused_unsafe_runtime");
  });

  it("passes a bounded unsupported Poetry identity to the DB without pnpm coercion", async () => {
    const raw = structuredClone(VALID);
    const identity = { ecosystem: "python", manager: "poetry", profile: "poetry_lock_v1" };
    raw.candidate = { ...raw.candidate, identity, currentVersion: "1.0rc1", targetVersion: "1.0rc2" };
    raw.runtime = { ...raw.runtime, identity, version: "cpython-3.13" };
    raw.packageManager = {
      ...raw.packageManager,
      name: "poetry",
      version: "2.1.4",
      profile: "poetry_lock_v1",
      updateArgv: ["poetry", "update", "@acme/widget", "--lock"],
    };
    raw.manifest = { ...raw.manifest, path: "pyproject.toml" };
    raw.lockfile = { ...raw.lockfile, path: "poetry.lock" };
    raw.security = { ...raw.security, identity, provider: "opaque", reference: "opaque:poetry-observation" };
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(
      dbResult("recorded", "refused_unsupported_profile", ["unsupported_manager_profile"]) as never
    );
    const response = await POST(request(raw));
    expect(response.status).toBe(201);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({ identity, currentVersion: "1.0rc1" }),
      runtime: expect.objectContaining({ identity, version: "cpython-3.13" }),
      packageManager: expect.objectContaining({ name: "poetry", profile: "poetry_lock_v1" }),
      manifest: expect.objectContaining({ path: "pyproject.toml" }),
      lockfile: expect.objectContaining({ path: "poetry.lock" }),
      security: expect.objectContaining({ identity, provider: "opaque" }),
    }));
    await expect(response.json()).resolves.toMatchObject({
      status: "refused_unsupported_profile", reasons: ["unsupported_manager_profile"],
    });
  });

  it.each([
    ["extra authority", { ...VALID, repo: "acme/widget" }],
    ["unsafe specifier", { ...VALID, candidate: { ...VALID.candidate, specifier: "workspace:*" } }],
    ["bad media type", VALID, "text/plain"],
  ])("rejects malformed input before DB: %s", async (_label, body, contentType = "application/json") => {
    const response = await POST(request(body, { contentType }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid dependency observation" });
    expect(recordAcceptanceDependencyObservation).not.toHaveBeenCalled();
  });

  it("returns exact replay truth without a second call", async () => {
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(dbResult("replayed") as never);
    const response = await POST(request(VALID));
    expect(response.status).toBe(200);
    expect((await response.json()).kind).toBe("replayed");
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: "not_found" }, 404, { kind: "not_found" }],
    [{ kind: "not_current" }, 409, { kind: "not_current" }],
    [
      { kind: "not_ready", reason: "compiled_pack_unavailable" },
      409,
      { kind: "not_ready", reason: "compiled_pack_unavailable" },
    ],
  ])("maps a closed DB result without expanding authority", async (result, status, body) => {
    vi.mocked(recordAcceptanceDependencyObservation).mockResolvedValue(result as never);
    const response = await POST(request(VALID));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(recordAcceptanceDependencyObservation).toHaveBeenCalledTimes(1);
  });

  it("maps immutable evidence conflict to a sanitized 409", async () => {
    vi.mocked(recordAcceptanceDependencyObservation).mockRejectedValue(
      new AcceptanceDependencyObservationConflictError()
    );
    const response = await POST(request(VALID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ kind: "conflict" });
  });

  it("maps storage failure to a sanitized 503 without raw details", async () => {
    const error = new Error("postgres://user:password@internal/db");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(recordAcceptanceDependencyObservation).mockRejectedValue(error);
    const response = await POST(request(VALID));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Dependency observation unavailable" });
    expect(console.error).toHaveBeenCalledWith("Acceptance dependency observation storage unavailable");
  });
});
