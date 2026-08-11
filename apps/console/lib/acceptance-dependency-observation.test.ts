import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES,
  ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS,
  parseAcceptanceDependencyObservation,
  readBoundedAcceptanceDependencyObservationJson,
} from "./acceptance-dependency-observation";

afterEach(() => {
  vi.useRealTimers();
});

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
  runtime: {
    identity: { ecosystem: "node", manager: "pnpm", profile: "pnpm_lockfile_only_v1" },
    disposition: "safe",
    version: "22.14.0",
    evidenceSha256: "a".repeat(64),
  },
  packageManager: {
    disposition: "safe",
    name: "pnpm",
    version: "10.14.0",
    profile: "pnpm_lockfile_only_v1",
    updateArgv: [
      "pnpm",
      "update",
      "@acme/widget@1.3.0",
      "--lockfile-only",
      "--ignore-scripts",
    ],
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
} as const;

function cloneValid(): Record<string, unknown> {
  return structuredClone(VALID) as unknown as Record<string, unknown>;
}

describe("parseAcceptanceDependencyObservation", () => {
  it("normalizes the bounded fixed pnpm profile without claiming approval", () => {
    const raw = cloneValid();
    raw.workspaceId = (raw.workspaceId as string).toUpperCase();
    (raw.baseline as { headSha: string }).headSha = "F".repeat(40);
    const result = parseAcceptanceDependencyObservation(raw);
    expect(result).toEqual({
      input: {
        ...VALID,
        workspaceId: VALID.workspaceId,
        baseline: { headSha: "f".repeat(40) },
      },
      boundaryAssessment: "candidate_for_server_verification",
    });
    expect(JSON.stringify(result)).not.toMatch(/approv/iu);
  });

  it.each([
    ["arbitrary command", ["pnpm", "exec", "postinstall"]],
    ["script-enabled update", ["pnpm", "update", "@acme/widget@1.3.0", "--lockfile-only"]],
    ["competing install", ["npm", "install", "@acme/widget@1.3.0"]],
  ])("records a bounded %s as refused unsafe runtime evidence", (_label, updateArgv) => {
    const raw = cloneValid();
    (raw.packageManager as { updateArgv: string[] }).updateArgv = updateArgv;
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_unsafe_runtime");
  });

  it("records an explicitly unsafe runtime as refused unsafe runtime evidence", () => {
    const raw = cloneValid();
    Object.assign(raw.runtime as object, { disposition: "unsafe", version: "latest" });
    expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_unsafe_runtime");
  });

  it.each(["missing", "uncommitted", "unavailable", "ambiguous"] as const)(
    "records a %s lockfile as refused lockfile evidence",
    (disposition) => {
      const raw = cloneValid();
      Object.assign(raw.lockfile as object, { disposition, blobSha: null });
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_lockfile");
    }
  );

  it.each(["affected", "unavailable", "ambiguous"] as const)(
    "records %s security as refused security evidence",
    (disposition) => {
      const raw = cloneValid();
      (raw.security as { disposition: string }).disposition = disposition;
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("refused_security");
    }
  );

  it.each(["runtime", "packageManager"] as const)(
    "records unavailable %s evidence as not proven",
    (field) => {
      const raw = cloneValid();
      Object.assign(raw[field] as object, {
        disposition: "unavailable",
        ...(field === "runtime" ? { version: null } : { version: null }),
      });
      expect(parseAcceptanceDependencyObservation(raw)?.boundaryAssessment).toBe("not_proven");
    }
  );

  it.each([
    ["unknown top-level field", (raw: Record<string, unknown>) => { raw.repo = "acme/widget"; }],
    ["unknown nested field", (raw: Record<string, unknown>) => { (raw.candidate as Record<string, unknown>).headSha = "a".repeat(40); }],
    ["unsafe path", (raw: Record<string, unknown>) => { (raw.manifest as { path: string }).path = "../package.json"; }],
    ["wrong manifest", (raw: Record<string, unknown>) => { (raw.manifest as { path: string }).path = "packages/widget/package-lock.json"; }],
    ["wrong lockfile", (raw: Record<string, unknown>) => { (raw.lockfile as { path: string }).path = "package-lock.json"; }],
    ["same version", (raw: Record<string, unknown>) => { (raw.candidate as { targetVersion: string }).targetVersion = "1.2.3"; }],
    ["non-semver candidate", (raw: Record<string, unknown>) => { (raw.candidate as { targetVersion: string }).targetVersion = "latest"; }],
    ["unsafe candidate specifier", (raw: Record<string, unknown>) => { (raw.candidate as { specifier: string }).specifier = "workspace:*"; }],
    ["unsafe package-manager name", (raw: Record<string, unknown>) => { (raw.packageManager as { name: string }).name = "PNPM"; }],
    ["wrong security provider", (raw: Record<string, unknown>) => { (raw.security as { provider: string }).provider = "github"; }],
    ["external security reference", (raw: Record<string, unknown>) => { (raw.security as { reference: string }).reference = "https://osv.dev/report"; }],
    ["secret-shaped evidence", (raw: Record<string, unknown>) => { (raw.candidate as { specifier: string }).specifier = "token=github_pat_abcdefghijklmnopqrstuvwxyz"; }],
  ])("rejects malformed input: %s", (_label, mutate) => {
    const raw = cloneValid();
    mutate(raw);
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
  });

  it.each([
    ["python", "poetry", "poetry_lock_v1"], ["python", "uv", "uv_lock_v1"],
    ["python", "pip", "pip_requirements_v1"], ["rust", "cargo", "cargo_lock_v1"],
    ["go", "go-modules", "go_mod_v1"], ["node", "yarn", "yarn_lock_v1"],
    ["node", "bun", "bun_lock_v1"], ["jvm", "maven", "maven_lock_v1"],
    ["jvm", "gradle", "gradle_lock_v1"], ["dotnet", "dotnet", "nuget_lock_v1"],
    ["php", "composer", "composer_lock_v1"],
  ])("accepts bounded unsupported %s/%s identity for server refusal", (ecosystem, manager, profile) => {
    const raw = cloneValid();
    for (const field of [raw.candidate, raw.runtime, raw.security] as Array<Record<string, unknown>>) {
      field.identity = { ecosystem, manager, profile };
    }
    (raw.candidate as Record<string, unknown>).currentVersion = "release-1";
    (raw.candidate as Record<string, unknown>).targetVersion = "release-2";
    (raw.runtime as Record<string, unknown>).version = "runtime-unknown";
    Object.assign(raw.packageManager as Record<string, unknown>, {
      name: manager,
      version: "manager-version-unknown",
      profile,
      updateArgv: [manager, "update", "example-package"],
    });
    (raw.manifest as Record<string, unknown>).path = "ecosystem/manifest.file";
    (raw.lockfile as Record<string, unknown>).path = "ecosystem/lock.file";
    (raw.security as Record<string, unknown>).provider = "unknown-provider";
    (raw.security as Record<string, unknown>).reference = "opaque:server-verified-only";
    const parsed = parseAcceptanceDependencyObservation(raw);
    expect(parsed?.boundaryAssessment).toBe("refused_unsupported_profile");
    expect(parsed?.input.packageManager).toMatchObject({ name: manager, profile });
    expect(JSON.stringify(parsed)).not.toContain("pnpm");
  });

  it("rejects legacy v1 runner bodies instead of inferring a manager identity", () => {
    const raw = cloneValid();
    delete (raw.candidate as Record<string, unknown>).identity;
    delete (raw.runtime as Record<string, unknown>).identity;
    (raw.runtime as Record<string, unknown>).nodeVersion = (raw.runtime as Record<string, unknown>).version;
    delete (raw.runtime as Record<string, unknown>).version;
    delete (raw.security as Record<string, unknown>).identity;
    expect(parseAcceptanceDependencyObservation(raw)).toBeNull();
  });
});

describe("readBoundedAcceptanceDependencyObservationJson", () => {
  it("reads fatal UTF-8 JSON within the fixed limit", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(VALID),
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: true,
      value: VALID,
    });
  });

  it("rejects a declared oversize body before parsing it", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES + 1),
      },
      body: "{}",
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });
  });

  it("cancels a streamed body that crosses the fixed limit", async () => {
    let cancelled = false;
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_BYTES + 1));
        },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "invalid_length",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects fatal UTF-8 and non-JSON media types", async () => {
    const badUtf8 = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await expect(readBoundedAcceptanceDependencyObservationJson(badUtf8)).resolves.toEqual({
      ok: false,
      reason: "invalid_json",
    });
    let cancelled = false;
    const wrongType = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
        cancel() { cancelled = true; },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(wrongType)).resolves.toEqual({
      ok: false,
      reason: "invalid_content_type",
    });
    expect(cancelled).toBe(true);
  });

  it("distinguishes a request stream failure from invalid JSON", async () => {
    const request = new Request("http://localhost/observation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error("socket closed")); },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedAcceptanceDependencyObservationJson(request)).resolves.toEqual({
      ok: false,
      reason: "body_unavailable",
    });
  });

  it("times out and cancels a stalled request body at the fixed deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const request = {
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
          cancel,
        }),
      },
    } as unknown as Request;
    const result = readBoundedAcceptanceDependencyObservationJson(request);
    await vi.advanceTimersByTimeAsync(ACCEPTANCE_DEPENDENCY_OBSERVATION_BODY_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
