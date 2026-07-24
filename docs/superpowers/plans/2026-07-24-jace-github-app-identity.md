# Jace GitHub App Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register Jace as a real GitHub App identity in code: console login via the App's OAuth, repo access via per-workspace installation tokens (`ghs_…`), every GitHub write attributed to `jace[bot]`, and the personal-OAuth-token plumbing (`getGithubToken`) deleted.

**Architecture:** A new pure `packages/github-app` (App JWT signing + installation-token minting, zero DB deps) is composed inside `packages/db-postgres` as `getInstallationToken(workspaceId)` — the drop-in replacement for `getGithubToken` at all 10 call sites. A new install flow (single-use random `state` token, house connect-link pattern) binds `installation_id` onto `workspaces`. The runner re-mints its push token at publish time via a new `POST /api/v1/runner/git-token`. Python's `token_provider.get_github_token` becomes the single Python seam, minting installation tokens itself.

**Tech Stack:** TypeScript (Next.js 15 App Router, Drizzle, vitest), Python 3 (pytest), `node:crypto` RS256 (no new TS deps), PyJWT+cryptography (Python).

**Spec:** `docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md` — read it first; its §2 decision table is binding.

## Global Constraints

- **Clean cutover:** `getGithubToken` (TS) is deleted in Task 9 — no fallback path may survive. Until Task 9, existing call sites keep working; each task's tests stay green on its own.
- **Env var names (exact):** `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_BOT_USER_ID`.
- **Tokens never logged.** Follow `github-merge.ts`'s posture: closed-union error reasons, never raw bodies or caught error messages containing tokens.
- **Workspace ids are never caller-supplied** on Jace/runner routes — resolve server-side (eveSessionId ledger or bearer-key claim), exactly like every existing route.
- **PR-per-change:** each Task is one branch + one PR (`feat/github-app-task-N-<slug>`), stacked on the previous task's branch if it depends on it, base `origin/main` otherwise. Never commit to main. End commit messages with the house co-author line.
- **Stale-dist gotcha:** after changing any built package (`packages/github-app`, `packages/db-postgres`), run `pnpm --filter <pkg> build` before running console tests or dev.
- **Migration gotcha:** generate migrations ONLY via `pnpm --filter @agentrail/db-postgres generate` (root `pnpm db:generate` is broken for this package). Never hand-create a `.sql` without a `_journal.json` entry.
- **Python tests:** `python -m pytest -q <paths>`; the repo's autouse conftest fixture already strips `AGENTRAIL_SERVER_*`.
- **Console tests:** `cd apps/console && npx vitest run <paths>`; package tests: `pnpm --filter @agentrail/db-postgres test`.

---

### Task 1: `packages/github-app` — pure GitHub App client

**Files:**
- Create: `packages/github-app/package.json`
- Create: `packages/github-app/tsconfig.json`
- Create: `packages/github-app/src/index.ts`
- Create: `packages/github-app/vitest.config.ts`
- Test: `packages/github-app/src/index.test.ts`
- Modify: `apps/console/next.config.ts` (add `@agentrail/github-app` to `transpilePackages`)
- Modify: root `package.json` (`predev` — add `--filter @agentrail/github-app` so its dist pre-builds like db-postgres)

**Interfaces:**
- Consumes: nothing (pure; env passed in explicitly).
- Produces (Task 2 composes these; Task 7's endpoint uses them):
  - `resolveGithubAppConfig(env: NodeJS.ProcessEnv): { ok: true; appId: string; privateKey: string; slug: string; botUserId: string } | { ok: false; missing: string[] }`
  - `signAppJwt(appId: string, privateKeyPem: string, nowSeconds?: number): string`
  - `mintInstallationToken(installationId: string, cfg: { appId: string; privateKey: string }, fetchImpl?: typeof fetch): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; reason: "not_installed" | "github_unreachable" | "github_rejected" }>`
  - `getInstallationAccount(installationId: string, cfg: { appId: string; privateKey: string }, fetchImpl?: typeof fetch): Promise<{ ok: true; login: string; type: "User" | "Organization" } | { ok: false; reason: "not_installed" | "github_unreachable" | "github_rejected" }>`
  - `botCommitIdentity(slug: string, botUserId: string): { name: string; email: string }` → `{ name: "<slug>[bot]", email: "<botUserId>+<slug>[bot]@users.noreply.github.com" }`

- [ ] **Step 1: Scaffold the package** (mirror `packages/db-postgres`'s tsc+dist pattern — it must be `tsc`-built because `@agentrail/db-postgres` (built) will depend on it in Task 2)

`packages/github-app/package.json`:
```json
{
  "name": "@agentrail/github-app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```
(Match the vitest major already used by `packages/db-postgres` — check its `package.json` and pin the same range.)

`packages/github-app/tsconfig.json` — copy `packages/db-postgres/tsconfig.json` verbatim, then set `"outDir": "./dist"` and `"include": ["src"]` if not already.

`packages/github-app/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write the failing tests**

`packages/github-app/src/index.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  resolveGithubAppConfig,
  signAppJwt,
  mintInstallationToken,
  getInstallationAccount,
  botCommitIdentity,
} from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_SLUG: "jace",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_BOT_USER_ID: "98765",
};

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("resolveGithubAppConfig", () => {
  it("returns ok with all four values present", () => {
    const cfg = resolveGithubAppConfig(ENV as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ ok: true, appId: "12345", slug: "jace", botUserId: "98765" });
  });

  it("lists every missing var", () => {
    const cfg = resolveGithubAppConfig({} as NodeJS.ProcessEnv);
    expect(cfg.ok).toBe(false);
    if (!cfg.ok) {
      expect(cfg.missing).toEqual([
        "GITHUB_APP_ID",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_BOT_USER_ID",
      ]);
    }
  });

  it("normalizes literal \\n sequences in the private key (env-var transport)", () => {
    const cfg = resolveGithubAppConfig({
      ...ENV,
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
    } as NodeJS.ProcessEnv);
    expect(cfg.ok).toBe(true);
    if (cfg.ok) expect(cfg.privateKey).toContain("\n");
  });
});

describe("signAppJwt", () => {
  it("produces an RS256 JWT with iss=appId, iat backdated 60s, exp 9min out", () => {
    const now = 1_800_000_000;
    const jwt = signAppJwt("12345", privateKey, now);
    const [h, p, s] = jwt.split(".");
    expect(b64urlJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = b64urlJson(p);
    expect(payload).toEqual({ iss: "12345", iat: now - 60, exp: now + 540 });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  const cfg = { appId: "12345", privateKey };

  it("POSTs to the installation access_tokens endpoint with the app JWT and returns the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_abc", expires_at: "2026-07-24T12:00:00Z" }),
    });
    const res = await mintInstallationToken("777", cfg, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, token: "ghs_abc", expiresAt: "2026-07-24T12:00:00Z" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/777/access_tokens");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(init.headers.Accept).toBe("application/vnd.github+json");
  });

  it("classifies 404 as not_installed (uninstall surfaces lazily here)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const res = await mintInstallationToken("777", cfg, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: false, reason: "not_installed" });
  });

  it("classifies network failure as github_unreachable, other non-2xx as github_rejected", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await mintInstallationToken("777", cfg, boom as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "github_unreachable",
    });
    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
    expect(await mintInstallationToken("777", cfg, rejected as unknown as typeof fetch)).toEqual({
      ok: false,
      reason: "github_rejected",
    });
  });
});

describe("getInstallationAccount", () => {
  it("GETs the installation and returns account login/type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account: { login: "acme-org", type: "Organization" } }),
    });
    const res = await getInstallationAccount("777", { appId: "12345", privateKey }, fetchMock as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, login: "acme-org", type: "Organization" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/app/installations/777");
  });
});

describe("botCommitIdentity", () => {
  it("builds the bot-user-id noreply identity (user id, NOT app id)", () => {
    expect(botCommitIdentity("jace", "98765")).toEqual({
      name: "jace[bot]",
      email: "98765+jace[bot]@users.noreply.github.com",
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/github-app && npx vitest run`
Expected: FAIL — cannot resolve `./index.js` exports.

- [ ] **Step 4: Implement `src/index.ts`**

```ts
/**
 * @agentrail/github-app — pure GitHub App client (spec:
 * docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §3/§6).
 *
 * Deliberately has ZERO workspace/DB knowledge: @agentrail/db-postgres
 * composes these into workspace-aware helpers (getInstallationToken), which
 * keeps the package dependency graph one-directional (db-postgres -> here,
 * never back). JWT is signed with node:crypto — no new dependency; GitHub
 * requires RS256, iat backdated for clock drift, exp <= 10 minutes.
 *
 * Tokens and private keys never appear in returned errors: every failure is
 * a closed-union reason code, same contract as apps/console/lib/github-merge.ts.
 */
import { createSign } from "node:crypto";

export interface GithubAppConfig {
  ok: true;
  appId: string;
  privateKey: string;
  slug: string;
  botUserId: string;
}
export interface GithubAppConfigMissing {
  ok: false;
  missing: string[];
}

const REQUIRED_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_BOT_USER_ID",
] as const;

export function resolveGithubAppConfig(
  env: NodeJS.ProcessEnv
): GithubAppConfig | GithubAppConfigMissing {
  const missing = REQUIRED_VARS.filter((v) => !String(env[v] ?? "").trim());
  if (missing.length) return { ok: false, missing: [...missing] };
  // Env-var transport (Railway, compose env_file) often flattens PEM newlines
  // to literal "\n" — normalize so createSign always gets a real PEM.
  const privateKey = String(env["GITHUB_APP_PRIVATE_KEY"]).replace(/\\n/g, "\n");
  return {
    ok: true,
    appId: String(env["GITHUB_APP_ID"]).trim(),
    privateKey,
    slug: String(env["GITHUB_APP_SLUG"]).trim(),
    botUserId: String(env["GITHUB_APP_BOT_USER_ID"]).trim(),
  };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function signAppJwt(
  appId: string,
  privateKeyPem: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 60s (GitHub's documented clock-drift allowance); exp 9min —
  // under the 10-minute hard cap with margin.
  const payload = b64url(
    JSON.stringify({ iss: appId, iat: nowSeconds - 60, exp: nowSeconds + 540 })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export type GithubAppFailure = {
  ok: false;
  reason: "not_installed" | "github_unreachable" | "github_rejected";
};

const GITHUB_FETCH_TIMEOUT_MS = 8000;

async function appFetch(
  url: string,
  method: "GET" | "POST",
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch
): Promise<{ ok: true; body: unknown } | GithubAppFailure> {
  const jwt = signAppJwt(cfg.appId, cfg.privateKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "agentrail-console",
      },
      signal: controller.signal,
    } as RequestInit);
  } catch {
    return { ok: false, reason: "github_unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 404 = the installation id no longer exists — the app was uninstalled.
    // This is the spec's "lazy uninstall detection" surfacing point (§2).
    if (res.status === 404) return { ok: false, reason: "not_installed" };
    return { ok: false, reason: "github_rejected" };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: true, body };
}

export async function mintInstallationToken(
  installationId: string,
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; token: string; expiresAt: string } | GithubAppFailure> {
  const res = await appFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    "POST",
    cfg,
    fetchImpl
  );
  if (!res.ok) return res;
  const body = res.body as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    return { ok: false, reason: "github_rejected" };
  }
  return {
    ok: true,
    token: body.token,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : "",
  };
}

export async function getInstallationAccount(
  installationId: string,
  cfg: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<
  { ok: true; login: string; type: "User" | "Organization" } | GithubAppFailure
> {
  const res = await appFetch(
    `https://api.github.com/app/installations/${installationId}`,
    "GET",
    cfg,
    fetchImpl
  );
  if (!res.ok) return res;
  const account = (res.body as { account?: { login?: unknown; type?: unknown } })
    .account;
  const login = typeof account?.login === "string" ? account.login : "";
  const type = account?.type === "Organization" ? "Organization" : "User";
  if (!login) return { ok: false, reason: "github_rejected" };
  return { ok: true, login, type };
}

/**
 * The git commit identity that attributes pushed commits to the App's bot
 * user. NOTE: the numeric id is the BOT USER's database id (GET /users/<slug>[bot]),
 * NOT the App id — the App id silently breaks avatar/profile linkage
 * (github-actions[bot] uses 41898282, not App id 15368).
 */
export function botCommitIdentity(
  slug: string,
  botUserId: string
): { name: string; email: string } {
  return {
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/github-app && npx vitest run`
Expected: PASS (all describes).

- [ ] **Step 6: Wire the workspace plumbing**

In `apps/console/next.config.ts`, add `"@agentrail/github-app"` to the existing `transpilePackages` array.
In root `package.json`, change `predev` to also build it, e.g. `"predev": "pnpm --filter @agentrail/db-postgres --filter @agentrail/github-app --filter @agentrail/mcp build"`.
Run: `pnpm install` (registers the new workspace package), then `pnpm --filter @agentrail/github-app build`.
Expected: `packages/github-app/dist/index.js` exists.

- [ ] **Step 7: Commit**

```bash
git add packages/github-app apps/console/next.config.ts package.json pnpm-lock.yaml
git commit -m "feat(github-app): pure App client — JWT signing, installation tokens, bot identity"
```

---

### Task 2: Migration + workspace-aware queries in db-postgres

**Files:**
- Modify: `packages/db-postgres/src/schema/workspaces.ts`
- Modify: `packages/db-postgres/package.json` (add dep `"@agentrail/github-app": "workspace:*"`)
- Create: `packages/db-postgres/src/queries/github-app-token.ts`
- Modify: `packages/db-postgres/src/index.ts` (export the new queries)
- Create (generated): `packages/db-postgres/drizzle/migrations/0043_*.sql` + journal entry — via drizzle-kit ONLY
- Test: `packages/db-postgres/src/__tests__/github-app-token.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveGithubAppConfig`, `mintInstallationToken` from `@agentrail/github-app`.
- Produces (all exported from `@agentrail/db-postgres` barrel; Tasks 3–8 consume):
  - `getInstallationToken(workspaceId: string): Promise<string | null>` — **the drop-in `getGithubToken` replacement**: same signature, null on any failure (no installation bound, env unconfigured, GitHub down). Never throws.
  - `getGithubInstallation(workspaceId: string): Promise<{ installationId: string; accountLogin: string; accountType: "User" | "Organization" } | null>` — cheap DB-only read (UI gating, org-vs-personal branch).
  - `bindWorkspaceGithubInstallation(workspaceId: string, data: { installationId: string; accountLogin: string; accountType: string }): Promise<void>`
  - `mintGithubInstallState(workspaceId: string): Promise<string>` — random 24-byte hex, 30-min TTL, stored on the workspace row (last-write-wins, one live state per workspace).
  - `consumeGithubInstallState(state: string): Promise<{ workspaceId: string } | null>` — atomic single-use `UPDATE … RETURNING` (house connect-link pattern).

- [ ] **Step 1: Add the columns** — append to the `workspaces` pgTable in `packages/db-postgres/src/schema/workspaces.ts`, following the file's heavy-comment convention:

```ts
  // GitHub App installation (spec 2026-07-24-jace-github-app-identity §5).
  // The workspace's bound installation of the Jace GitHub App — the ONLY
  // GitHub credential source after the cutover (getInstallationToken mints
  // short-lived ghs_ tokens from it; the old accounts.access_token path is
  // deleted). Null = GitHub not connected; every GitHub-touching route
  // surfaces a clear "Connect GitHub" error in that case. Account login/type
  // are captured at install-callback time (GET /app/installations/{id}) so
  // create_repo can branch org-vs-personal without a live GitHub call.
  githubInstallationId: text("github_installation_id"),
  githubInstallationAccountLogin: text("github_installation_account_login"),
  githubInstallationAccountType: text("github_installation_account_type"),
  // Single-use install-flow state token (house connect-link pattern —
  // chat_identities.link_token): minted when the owner clicks "Connect
  // GitHub", carried through GitHub's install redirect as ?state=, consumed
  // atomically (UPDATE … RETURNING) at the callback. Deliberately NOT HMAC.
  githubInstallState: text("github_install_state"),
  githubInstallStateExpiresAt: timestamp("github_install_state_expires_at", {
    withTimezone: true,
  }),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @agentrail/db-postgres generate`
Expected: new `drizzle/migrations/0043_<autoname>.sql` containing five `ALTER TABLE "workspaces" ADD COLUMN` statements, and `meta/_journal.json` gains an `idx: 44` entry. Verify BOTH exist (`git status` shows the sql + journal diff) — a missing journal entry silently skips the migration.

- [ ] **Step 3: Write the failing query tests**

`packages/db-postgres/src/__tests__/github-app-token.test.ts` — mirror the `github-token-query.test.ts` mocked-chain style plus `vi.mock` of `@agentrail/github-app`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm --filter @agentrail/db-postgres test -- github-app-token`
Expected: FAIL — module `../queries/github-app-token.js` not found.

- [ ] **Step 5: Implement `packages/db-postgres/src/queries/github-app-token.ts`**

```ts
/**
 * GitHub App installation credentials (spec:
 * docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md §5/§6).
 *
 * getInstallationToken(workspaceId) is the drop-in replacement for the
 * deleted getGithubToken: same (workspaceId) => Promise<string | null>
 * contract, so all ten former call sites swap imports without reshaping
 * their null-handling. Null means "workspace has no usable GitHub
 * credential" for ANY reason — no installation bound, App env unconfigured,
 * GitHub unreachable, or the App was uninstalled (lazy detection, spec §2).
 * Callers keep their existing "Connect GitHub" error copy on null.
 *
 * Tokens are minted fresh per call (spec §2: no caching in v1) and NEVER
 * stored or logged.
 */
import { and, eq, gt } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  resolveGithubAppConfig,
  mintInstallationToken,
} from "@agentrail/github-app";
import { db } from "../db.js";
import { workspaces } from "../schema/index.js";

const INSTALL_STATE_BYTES = 24;
const INSTALL_STATE_TTL_MS = 30 * 60 * 1000;

export async function getGithubInstallation(workspaceId: string): Promise<{
  installationId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
} | null> {
  const rows = await db
    .select({
      installationId: workspaces.githubInstallationId,
      accountLogin: workspaces.githubInstallationAccountLogin,
      accountType: workspaces.githubInstallationAccountType,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row?.installationId) return null;
  return {
    installationId: row.installationId,
    accountLogin: row.accountLogin ?? "",
    accountType: row.accountType === "Organization" ? "Organization" : "User",
  };
}

export async function getInstallationToken(
  workspaceId: string
): Promise<string | null> {
  try {
    const installation = await getGithubInstallation(workspaceId);
    if (!installation) return null;
    const cfg = resolveGithubAppConfig(process.env);
    if (!cfg.ok) return null;
    const minted = await mintInstallationToken(installation.installationId, {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
    });
    return minted.ok ? minted.token : null;
  } catch {
    return null;
  }
}

export async function bindWorkspaceGithubInstallation(
  workspaceId: string,
  data: { installationId: string; accountLogin: string; accountType: string }
): Promise<void> {
  await db
    .update(workspaces)
    .set({
      githubInstallationId: data.installationId,
      githubInstallationAccountLogin: data.accountLogin,
      githubInstallationAccountType: data.accountType,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));
}

export async function mintGithubInstallState(
  workspaceId: string
): Promise<string> {
  const state = randomBytes(INSTALL_STATE_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + INSTALL_STATE_TTL_MS);
  await db
    .update(workspaces)
    .set({ githubInstallState: state, githubInstallStateExpiresAt: expiresAt })
    .where(eq(workspaces.id, workspaceId));
  return state;
}

/** Atomic single-use consume — mirrors consumeChatIdentityLinkToken exactly. */
export async function consumeGithubInstallState(
  state: string
): Promise<{ workspaceId: string } | null> {
  const now = new Date();
  const rows = await db
    .update(workspaces)
    .set({ githubInstallState: null, githubInstallStateExpiresAt: null })
    .where(
      and(
        eq(workspaces.githubInstallState, state),
        gt(workspaces.githubInstallStateExpiresAt, now)
      )
    )
    .returning({ id: workspaces.id });
  const row = rows[0];
  return row ? { workspaceId: row.id } : null;
}
```

Add to `packages/db-postgres/src/index.ts` (alongside the existing exports):
```ts
export {
  getInstallationToken,
  getGithubInstallation,
  bindWorkspaceGithubInstallation,
  mintGithubInstallState,
  consumeGithubInstallState,
} from "./queries/github-app-token.js";
```
Add to `packages/db-postgres/package.json` dependencies: `"@agentrail/github-app": "workspace:*"`, then `pnpm install`.

- [ ] **Step 6: Run tests + build**

Run: `pnpm --filter @agentrail/github-app build && pnpm --filter @agentrail/db-postgres build && pnpm --filter @agentrail/db-postgres test`
Expected: new tests PASS, existing tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db-postgres pnpm-lock.yaml
git commit -m "feat(db): workspaces installation columns + getInstallationToken (migration 0043)"
```

---

### Task 3: Install flow — mint endpoint, global callback, Connect GitHub UI

**Files:**
- Create: `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/install-link/route.ts`
- Create: `apps/console/app/api/v1/connectors/github/install-callback/route.ts`
- Modify: `apps/console/app/(dashboard)/dashboard/[workspaceId]/connectors/components/connectors-panel.tsx` (the `GithubManage` component)
- Modify: `apps/console/app/(dashboard)/setup/components/github-step.tsx` (add the same Connect button above "Add repository")
- Test: `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/install-link/route.test.ts`
- Test: `apps/console/app/api/v1/connectors/github/install-callback/route.test.ts`

**Interfaces:**
- Consumes (Task 2): `mintGithubInstallState`, `consumeGithubInstallState`, `bindWorkspaceGithubInstallation`, `getGithubInstallation`; (Task 1 via `@agentrail/github-app`): `resolveGithubAppConfig`, `getInstallationAccount`. Also existing `auth` (`@agentrail/auth`) and `getWorkspaceMembership` (`@agentrail/db-postgres`).
- Produces: `POST /api/v1/workspaces/[workspaceId]/connectors/github/install-link` → `200 { url }` (or `503 { error }` when App env unset); `GET /api/v1/connectors/github/install-callback?installation_id&state` → 302 redirects.

- [ ] **Step 1: Write failing tests for the mint endpoint**

`install-link/route.test.ts` — copy the mock scaffolding style from `connectors/github/webhook/route.test.ts` verbatim (same `vi.mock("@agentrail/auth")`, `vi.mock("@agentrail/db-postgres")` including `getWorkspaceMembership: vi.fn(), mintGithubInstallState: vi.fn()`; plus `vi.mock("@agentrail/github-app", () => ({ resolveGithubAppConfig: vi.fn() }))`). Cases:
1. 401 when unauthenticated (`auth` → null).
2. 403 when membership role is `"member"` (not in `["owner", "admin"]`).
3. 503 `{ error: "GitHub App is not configured on this deployment" }` when `resolveGithubAppConfig` → `{ ok: false, missing: [...] }`.
4. Happy path: `resolveGithubAppConfig` → ok with `slug: "jace"`; `mintGithubInstallState` → `"abc123"`; expect 200 and body `{ url: "https://github.com/apps/jace/installations/new?state=abc123" }`, and `mintGithubInstallState` called with the route's workspaceId.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/console && npx vitest run app/api/v1/workspaces/\[workspaceId\]/connectors/github/install-link`
Expected: FAIL — route module missing.

- [ ] **Step 3: Implement the mint endpoint**

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  getWorkspaceMembership,
  mintGithubInstallState,
} from "@agentrail/db-postgres";
import { resolveGithubAppConfig } from "@agentrail/github-app";

const ADMIN_ROLES = ["owner", "admin"];

/**
 * POST /api/v1/workspaces/[workspaceId]/connectors/github/install-link
 *
 * Mints the single-use install URL for GitHub's App-installation flow (spec
 * §5). Session-authed + admin-gated like the sibling webhook route — an
 * explicit button click only. The returned URL carries a 30-minute,
 * single-use `state` token bound server-side to THIS workspace; the global
 * install-callback consumes it atomically, so a tampered or replayed state
 * can never bind an installation to a workspace the clicker isn't an
 * admin of.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ workspaceId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { workspaceId } = await ctx.params;
  const membership = await getWorkspaceMembership(session.user.id, workspaceId);
  if (!membership || !ADMIN_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cfg = resolveGithubAppConfig(process.env);
  if (!cfg.ok) {
    return NextResponse.json(
      { error: "GitHub App is not configured on this deployment" },
      { status: 503 }
    );
  }
  const state = await mintGithubInstallState(workspaceId);
  return NextResponse.json({
    url: `https://github.com/apps/${cfg.slug}/installations/new?state=${state}`,
  });
}
```
(Check the exact `getWorkspaceMembership` argument order against its definition in `@agentrail/db-postgres` before writing — the webhook route at `connectors/github/webhook/route.ts` line ~94 is the authoritative usage to copy.)

- [ ] **Step 4: Write failing tests for the callback**

`install-callback/route.test.ts` — mocks: `@agentrail/auth` (`auth`), `@agentrail/db-postgres` (`consumeGithubInstallState`, `bindWorkspaceGithubInstallation`, `getWorkspaceMembership`), `@agentrail/github-app` (`resolveGithubAppConfig`, `getInstallationAccount`). Build requests with `new NextRequest("http://localhost/api/v1/connectors/github/install-callback?installation_id=777&state=abc")`. Cases:
1. **No state param** → 302 redirect to `/dashboard?github_install=unlinked` (the "finish connecting from workspace settings" surfacing — a direct github.com/apps install).
2. **Unknown/expired state** (`consumeGithubInstallState` → null) → 302 to `/dashboard?github_install=expired`; `bindWorkspaceGithubInstallation` NOT called.
3. **Signed-out visitor** (`auth` → null) → 302 to `/login`; state NOT consumed (assert `consumeGithubInstallState` not called — consume only after auth, so a signed-out hit doesn't burn the token).
4. **Membership re-check fails** (state resolves ws-1 but `getWorkspaceMembership` → null) → 302 to `/dashboard?github_install=forbidden`, no bind.
5. **Happy path**: state → `{ workspaceId: "ws-1" }`, membership ok, `getInstallationAccount` → `{ ok: true, login: "acme", type: "Organization" }` → `bindWorkspaceGithubInstallation` called with `{ installationId: "777", accountLogin: "acme", accountType: "Organization" }`, 302 to `/dashboard/ws-1/connectors?github_install=connected`.
6. **Missing installation_id** with valid state → 302 `/dashboard?github_install=error`, no bind.

- [ ] **Step 5: Implement the callback**

```ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@agentrail/auth";
import {
  consumeGithubInstallState,
  bindWorkspaceGithubInstallation,
  getWorkspaceMembership,
} from "@agentrail/db-postgres";
import {
  resolveGithubAppConfig,
  getInstallationAccount,
} from "@agentrail/github-app";

/**
 * GET /api/v1/connectors/github/install-callback — the GitHub App's ONE
 * global Setup URL (spec §5: it cannot be workspace-scoped; the workspace
 * travels exclusively in the single-use `state` token).
 *
 * Order matters: auth FIRST, then consume. A signed-out hit redirects to
 * /login without burning the single-use state (the magic-link-over-chat
 * lesson: never consume a single-use token on a GET that isn't the real
 * redemption). Installs started directly on github.com/apps/<slug> arrive
 * with no state at all — those get a "finish from workspace settings"
 * redirect, never a guessed workspace.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state")?.trim() ?? "";
  const installationId = params.get("installation_id")?.trim() ?? "";
  const dest = (path: string) => NextResponse.redirect(new URL(path, request.url));

  if (!state) return dest("/dashboard?github_install=unlinked");

  const session = await auth();
  if (!session?.user?.id) return dest("/login");

  const consumed = await consumeGithubInstallState(state);
  if (!consumed) return dest("/dashboard?github_install=expired");

  const membership = await getWorkspaceMembership(
    session.user.id,
    consumed.workspaceId
  );
  if (!membership) return dest("/dashboard?github_install=forbidden");

  if (!installationId) return dest("/dashboard?github_install=error");

  // Capture account login/type once so create_repo can branch org-vs-personal
  // without a live GitHub call (spec §2). Best-effort on the account fetch:
  // a GitHub hiccup here must not lose the installation binding.
  let accountLogin = "";
  let accountType = "User";
  const cfg = resolveGithubAppConfig(process.env);
  if (cfg.ok) {
    const account = await getInstallationAccount(installationId, {
      appId: cfg.appId,
      privateKey: cfg.privateKey,
    });
    if (account.ok) {
      accountLogin = account.login;
      accountType = account.type;
    }
  }
  await bindWorkspaceGithubInstallation(consumed.workspaceId, {
    installationId,
    accountLogin,
    accountType,
  });
  return dest(
    `/dashboard/${consumed.workspaceId}/connectors?github_install=connected`
  );
}
```

- [ ] **Step 6: Run callback + mint tests**

Run: `cd apps/console && npx vitest run app/api/v1/connectors/github/install-callback app/api/v1/workspaces/\[workspaceId\]/connectors/github/install-link`
Expected: PASS.

- [ ] **Step 7: Add the Connect GitHub button (two surfaces)**

In `connectors-panel.tsx`, rewrite `GithubManage` to accept `workspaceId` (thread it from `ConnectorCard`, which already has it in scope — check how sibling manage components receive props) and render the button. Follow the sibling `SecretManage` client-fetch idiom exactly (its `saving` state + error display):

```tsx
// GitHub — a GitHub App installation, not a pasted credential: the button
// round-trips to mint a single-use install link, then sends the browser to
// GitHub's own install screen. (spec 2026-07-24-jace-github-app-identity §5)
function GithubManage({
  connector,
  workspaceId,
}: {
  connector: ConnectorView;
  workspaceId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/connectors/github/install-link`,
        { method: "POST" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the install");
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the install");
      setBusy(false);
    }
  }

  if (connector.status === "connected") {
    return (
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Jace is installed on your GitHub. Issues labeled{" "}
        <code className="font-mono text-[var(--gray-11)]">
          {connector.ingestLabel}
        </code>{" "}
        are ingested into the Issue Queue; run results post back on the issue.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-[var(--gray-09)]">
        Install the Jace GitHub App to let Jace review, push, and open PRs on
        the repos you pick — every action shows as Jace, not you.
      </p>
      <button
        type="button"
        onClick={connect}
        disabled={busy}
        className={/* copy the exact submit-button className from SecretManage */ ""}
      >
        {busy ? "Connecting…" : "Connect GitHub"}
      </button>
      {error && <p className="text-xs text-[var(--red-10)]">{error}</p>}
    </div>
  );
}
```
(The implementer copies the exact button classNames and error-line classes from `SecretManage` in the same file — visual consistency over invention. Match `useState` import to what the file already imports.)

In `github-step.tsx`: add the same `connect()` fetch + a "Connect GitHub App" button as the FIRST element of the step (before "Add repository"), reusing that file's existing button styling and its `workspaceId` prop. Copy explains order: install first, then add repositories.

- [ ] **Step 8: Verify in the browser** (house rule: console UI must be browser-verified — CI skips console UI)

Use the `verify-console-ui` skill's session-minting approach. Confirm: the Connectors page renders the new GitHub card copy and button; clicking it (with `GITHUB_APP_*` unset locally) surfaces the 503 error message inline, not a crash. Screenshot for the PR.

- [ ] **Step 9: Commit**

```bash
git add apps/console
git commit -m "feat(console): Connect GitHub install flow — mint endpoint, global callback, UI"
```

---

### Task 4: Login switches to the App's OAuth credentials

**Files:**
- Modify: `packages/auth/src/index.ts`
- Modify: `.env.example` (root)
- Modify: `apps/console/.env.local` is the USER's file — do not touch; note the needed change in the PR body instead.

**Interfaces:**
- Consumes: nothing new. Produces: login flow reading `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`.

- [ ] **Step 1: Swap the provider config** in `packages/auth/src/index.ts`:

```ts
  providers: [
    GitHub({
      // The Jace GitHub App's OAuth credentials (spec
      // docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md
      // §4) — same App as the installation flow, so the consent screen says
      // "Authorize Jace". No scope override: GitHub Apps don't grant repo
      // access via login-time OAuth scopes; repo access comes exclusively
      // from the workspace's App installation (installation tokens). The
      // access_token the adapter stores is inert login plumbing — nothing
      // reads it (getGithubToken is deleted; see getInstallationToken).
      clientId: process.env["GITHUB_APP_CLIENT_ID"]!,
      clientSecret: process.env["GITHUB_APP_CLIENT_SECRET"]!,
    }),
  ],
```
(Delete the `authorization: { params: { scope: … } }` block entirely.)

- [ ] **Step 2: Update root `.env.example`** — replace the GitHub section (lines ~16-19) with:

```
# Jace GitHub App (register at https://github.com/settings/apps — see the
# deploy example for the full registration checklist). ONE App serves both
# console login (client id/secret below) and repo access (App id + private
# key, read by @agentrail/github-app).
# Login callback URL on the App: http://localhost:3000/api/auth/callback/github
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
# Full PEM contents of the App's private key (literal \n newlines are OK).
GITHUB_APP_PRIVATE_KEY=
# Numeric user id of <slug>[bot] — curl https://api.github.com/users/<slug>%5Bbot%5D | jq .id
GITHUB_APP_BOT_USER_ID=
```

- [ ] **Step 3: Run the console test suite** (login provider is exercised indirectly)

Run: `cd apps/console && npx vitest run`
Expected: PASS (no test reads GITHUB_CLIENT_ID directly; if one does, update it to the new var).

- [ ] **Step 4: Commit**

```bash
git add packages/auth .env.example
git commit -m "feat(auth): console login via the Jace GitHub App's OAuth (no repo scope)"
```
PR body must include: "Deploy note: set GITHUB_APP_CLIENT_ID/SECRET (+ the four other GITHUB_APP_* vars) before deploying; login breaks without them. Local dev: update apps/console/.env.local the same way."

---

### Task 5: Mechanical call-site swaps (8 files) + error copy + tests

**Files (all Modify):**
- `apps/console/app/api/v1/runner/pr-review/route.ts` (line ~215) + `route.test.ts`
- `apps/console/app/api/v1/runner/result/route.ts` (line ~214) + its 3 test files
- `apps/console/app/api/v1/runner/claim/route.ts` (line ~172, comment block 157-169) + `route.test.ts`
- `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/webhook/route.ts` (line ~116) + `route.test.ts`
- `apps/console/app/api/v1/workspaces/[workspaceId]/failures/[failureId]/issue/route.ts` (line ~69) + `route.test.ts`
- `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts` (line ~108) + `route.test.ts`
- `packages/db-postgres/src/queries/ci-reconcile.ts` (line ~249, import line 19) + `__tests__/ci-reconcile.test.ts`
- `apps/console/app/(dashboard)/dashboard/[workspaceId]/failures/[failureId]/page.tsx` (line ~226) + `page.test.ts`

**Interfaces:**
- Consumes (Task 2): `getInstallationToken(workspaceId)` — same `Promise<string | null>` contract as `getGithubToken`, so control flow is unchanged everywhere. The failures page uses `getGithubInstallation` (cheap DB read) instead — no live mint for UI gating.
- Produces: nothing new; behavior-preserving swap. `getGithubToken` still EXISTS after this task (deleted in Task 9) — this task just removes its last production readers.

- [ ] **Step 1: Swap each call site.** The identical mechanical change, applied per file:
  - Import: replace `getGithubToken` with `getInstallationToken` in the `@agentrail/db-postgres` import list.
  - Call: `await getGithubToken(X)` → `await getInstallationToken(X)`.
  - **Exception — failures page** (`page.tsx:226`): replace with `getGithubInstallation(workspaceId)` in the `Promise.all`, and the gate on line ~233 becomes `if (installation && repo && parseGithubSlug(repo.url)) issueTargets.push("github");` — a token mint is a live GitHub round-trip and has no business on a page render.
  - **Exception — ci-reconcile.ts**: keep the lazy-import posture documented at `queries/index.ts:1825-1829`; import `getInstallationToken` from `"./github-app-token.js"` directly (it does not import `index.js`, so no cycle exists — note this in a one-line comment replacing the old cycle note if the old note names `getGithubToken`).

- [ ] **Step 2: Update the stale OAuth prose at each site** (these exact spots, found by recon):
  - `claim/route.ts:157-169` comment block — rewrite: the token is now a short-lived App installation token minted at claim; it expires in ~1 hour, which the runner handles by re-minting at publish time via `POST /api/v1/runner/git-token` (Task 7); `""` still means "no installation bound", runner falls back to local GIT_TOKEN.
  - `pr-review/route.ts:59-64` header + `classifyGithubError`'s `409 "GitHub rejected the stored credentials"` → `"GitHub rejected the workspace's App installation credentials — reconnect GitHub from the console"`.
  - `webhook/route.ts` line ~126 null-token copy → `"GitHub is not connected for this workspace — install the Jace GitHub App from Connectors first."`; per-repo 401/403/404 copy → `"GitHub denied the request — make sure the Jace GitHub App is installed on this repository, or add the webhook manually below."`
  - `failures/[failureId]/issue/route.ts:70-77` copy → `"GitHub is not connected for this workspace. Install the Jace GitHub App first."`; 401/403/404 copy (lines ~106-114) → `"GitHub denied the request — the Jace GitHub App is not installed on this repository (or the installation was removed). Reconnect from Connectors and retry."`
  - `review-gates/[gateId]/issue/route.ts` — same two copy updates as failures route.
  - `runner/result/route.ts:174-177` comment — s/getGithubToken/getInstallationToken/.
- [ ] **Step 3: Update every test file.** In each `vi.mock("@agentrail/db-postgres", …)` factory listed above: replace `getGithubToken: vi.fn()` with `getInstallationToken: vi.fn()` (failures page test: `getGithubInstallation: vi.fn()`), and update `vi.mocked(getGithubToken)` references + import lines to match. Token fixture values change from `"gho_…"` to `"ghs_…"` strings for honesty. Assertion text for the copy changes above must be updated in the same tests.

- [ ] **Step 4: Run everything**

Run: `pnpm --filter @agentrail/db-postgres build && pnpm --filter @agentrail/db-postgres test && cd apps/console && npx vitest run`
Expected: PASS across both suites.

- [ ] **Step 5: Commit**

```bash
git add apps/console packages/db-postgres
git commit -m "feat(console): all GitHub call sites mint App installation tokens"
```

---

### Task 6: `create_repo` split — org creates via API, personal gets the guided link

**Files:**
- Modify: `apps/console/app/api/v1/runner/repos/route.ts` + `route.test.ts`
- Modify: `apps/jace/agent/lib/create_repo.core.mjs` + its test (find it: `apps/jace/test/` — locate with `ls apps/jace/test | grep -i create_repo`)
- Modify: `apps/jace/agent/tools/create_repo.ts` (description text only)

**Interfaces:**
- Consumes: `getInstallationToken`, `getGithubInstallation` (Task 2); existing route contract `POST /api/v1/runner/repos` `{ eveSessionId, name, private? }`.
- Produces: NEW response variant `200 { guided: true, createUrl: "https://github.com/new", installUrl: string, name: string }` for personal-account installations. Org installations keep the existing `201 { repo, connected, webhookCreated, onboardQueued, warnings }` shape (creation via `POST /orgs/{login}/repos`). No-installation keeps the existing `409` with updated copy.

- [ ] **Step 1: Write the failing route tests** (extend `route.test.ts`, following its existing scaffolding):
1. Workspace with `getGithubInstallation` → `{ installationId: "777", accountLogin: "acme", accountType: "Organization" }`: fetch mock expects `https://api.github.com/orgs/acme/repos` (NOT `/user/repos`), same body `{ name, private, auto_init: true }`, and the existing 201 connect-chain response.
2. Workspace with `accountType: "User"`: NO GitHub fetch at all; response `200 { guided: true, createUrl: "https://github.com/new", installUrl: "https://github.com/apps/jace/installations/new", name: "<requested>" }` (installUrl built from `resolveGithubAppConfig(process.env)` slug — mock `@agentrail/github-app`).
3. `getGithubInstallation` → null: `409 { error: "GitHub is not connected for this workspace — install the Jace GitHub App first" }`.

- [ ] **Step 2: Implement in `repos/route.ts`.** Replace the `getGithubToken`/`POST /user/repos` block (lines ~300-343):

```ts
  const installation = await getGithubInstallation(workspaceId);
  if (!installation) {
    return NextResponse.json(
      {
        error:
          "GitHub is not connected for this workspace — install the Jace GitHub App first",
      },
      { status: 409 }
    );
  }

  // Personal accounts: GitHub structurally blocks App tokens from creating
  // user-owned repos (POST /user/repos has no App equivalent — spec §2's
  // create_repo decision, community discussions 65724/116331/171040). Hand
  // back a guided flow instead of a doomed API call: the user creates the
  // repo on GitHub's own /new page, adds it to the installation, and connects
  // it — the tool relays these exact links.
  if (installation.accountType !== "Organization") {
    const cfg = resolveGithubAppConfig(process.env);
    const installUrl = cfg.ok
      ? `https://github.com/apps/${cfg.slug}/installations/new`
      : "https://github.com/settings/installations";
    return NextResponse.json(
      {
        guided: true as const,
        createUrl: "https://github.com/new",
        installUrl,
        name: requestedName,
      },
      { status: 200 }
    );
  }

  const token = await getInstallationToken(workspaceId);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub rejected the workspace's App installation — reconnect GitHub from the console" },
      { status: 409 }
    );
  }

  let ghRes: Response;
  try {
    ghRes = await fetchWithTimeout(
      `https://api.github.com/orgs/${installation.accountLogin}/repos`,
      {
        method: "POST",
        headers: githubHeaders(token),
        body: JSON.stringify({ name: requestedName, private: isPrivate, auto_init: true }),
      }
    );
  } catch {
    return NextResponse.json({ error: "Could not reach GitHub." }, { status: 502 });
  }
```
Everything downstream (name-taken 422 handling, connect chain, webhook, onboard enqueue) is unchanged and now runs only on the org path. Update the module doc-comment's `GITHUB CALL` section (lines ~214-217) and the "WORKSPACE OWNER's stored OAuth access_token" paragraph (lines ~191-193) to describe the new split. Keep imports tidy: `getGithubToken` import goes away here; add `getGithubInstallation`, `getInstallationToken`, and `resolveGithubAppConfig`.

- [ ] **Step 3: Update `create_repo.core.mjs`** — handle the `guided` response. In the success-parsing section (lines ~195-222), add before the existing 201 handling:

```js
  if (status === 200 && body && body.guided === true) {
    const name = typeof body.name === "string" ? body.name : "the repo";
    const createUrl = typeof body.createUrl === "string" ? body.createUrl : "https://github.com/new";
    const installUrl = typeof body.installUrl === "string" ? body.installUrl : "";
    return {
      guided: true,
      message:
        `GitHub doesn't let apps create repos on personal accounts, so this one's a two-click job: ` +
        `1) create "${name}" here: ${createUrl}  ` +
        `2) add it to my installation here: ${installUrl}  ` +
        `Then add it to the workspace from the console's Repos page (Add repository) — ` +
        `or tell me once it exists and I'll walk you through.`,
    };
  }
```
Update the module-comment failure table to document the new variant. Extend its unit test with: a scripted transport returning `{ status: 200, json: async () => ({ guided: true, createUrl: "https://github.com/new", installUrl: "https://github.com/apps/jace/installations/new", name: "widgets" }) }` → assert the returned object has `guided: true` and the message contains both URLs.

**Spec §8 reachability note (org path):** after an org-path API create, the new repo may not be part of the installation when the owner chose "Only select repositories" — the connect chain's webhook registration then fails and the existing `webhookCreated: false` + `warnings` fields already surface it honestly (the tool's description mandates relaying that). Add one warning string to the route's `warnings` array when webhook creation fails with a 403/404: `"the new repo may not be in the Jace installation — add it at ${installUrl} if the webhook is missing"`. No new reachability round-trip needed.

- [ ] **Step 4: Update the tool description** in `create_repo.ts` — append to the description string: `"On personal GitHub accounts this returns { guided, message } instead — relay the message verbatim (GitHub blocks apps from creating personal repos; the user creates it via the links and you connect it after)."`

- [ ] **Step 5: Run tests**

Run: `cd apps/console && npx vitest run app/api/v1/runner/repos` and the jace test command for create_repo (check `apps/jace/package.json` scripts — likely `npm test` inside `apps/jace`; run only the create_repo file).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console apps/jace
git commit -m "feat(create-repo): org installs create via App token; personal accounts get the guided flow"
```

---

### Task 7: Publish-time token re-mint — console endpoint + runner wiring + bot identity

**Files:**
- Create: `apps/console/app/api/v1/runner/git-token/route.ts` + `route.test.ts`
- Modify: `agentrail/runner/client.py` (new `git_token()` method)
- Modify: `agentrail/cli/commands/runner.py` (`_make_execute`: thread a refresh callable)
- Modify: `agentrail/sandbox/native_runner.py` (`run_issue_on_host` signature + `_publish_green`)
- Test: `agentrail/tests/runner/test_client.py` (extend), `agentrail/tests/sandbox/test_native_runner.py` (extend), `agentrail/tests/runner/test_execute_github_token.py` (extend)

**Interfaces:**
- Consumes: `getInstallationToken` (Task 2); `botCommitIdentity` + `resolveGithubAppConfig` (Task 1); existing `requireBearer` (`apps/console/lib/bearer-auth.ts`), `authenticated_clone_url` (`agentrail/sandbox/clone_auth.py`).
- Produces:
  - `POST /api/v1/runner/git-token` (bearer = runner/fleet api_key, same as claim). Body: none. Workspace resolved from the bearer key (`auth.workspaceId`) — never caller-supplied. Response `200 { github_token: string, bot_name: string, bot_email: string }` or `409 { error: "no GitHub App installation for this workspace" }`.
  - Python: `RunnerClient.git_token() -> Optional[GitTokenGrant]` where `GitTokenGrant = dataclass(token: str, bot_name: str, bot_email: str)`; returns `None` on any non-200/network error (best-effort).
  - `run_issue_on_host(..., git_token_refresh=None)` — optional zero-arg callable returning `Optional[GitTokenGrant]`; `_publish_green(..., repo_url, git_token_refresh)` re-points origin + uses the grant's bot identity.

- [ ] **Step 1: Console endpoint — failing test first.** `git-token/route.test.ts`, mocking `apps/console/lib/bearer-auth`'s `requireBearer` (see how `claim/route.test.ts` mocks it — copy that scaffolding) and `@agentrail/db-postgres` (`getInstallationToken`) + `@agentrail/github-app` (`resolveGithubAppConfig`):
1. 401 passthrough when `requireBearer` returns a NextResponse.
2. 409 when `getInstallationToken` → null.
3. 200 `{ github_token: "ghs_fresh", bot_name: "jace[bot]", bot_email: "98765+jace[bot]@users.noreply.github.com" }` when token mints and App env is configured (mock `resolveGithubAppConfig` ok with slug `jace`, botUserId `98765`; the route composes identity via `botCommitIdentity` — also mock or import real from `@agentrail/github-app`; prefer mocking the whole module with the real `botCommitIdentity` behavior inlined in the factory).
4. When `resolveGithubAppConfig` → not ok but token minted (self-host partial config edge): 200 with `bot_name: "AgentRail Runner"`, `bot_email: "runner@agentrail.dev"` (fallback identity — push still works, attribution degrades honestly).

- [ ] **Step 2: Implement the endpoint**

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireBearer } from "../../../../../lib/bearer-auth";
import { getInstallationToken } from "@agentrail/db-postgres";
import { resolveGithubAppConfig, botCommitIdentity } from "@agentrail/github-app";

/**
 * POST /api/v1/runner/git-token — publish-time re-mint (spec §6).
 *
 * Installation tokens live 1 hour; runs legitimately exceed that (fleet
 * stale-run ceiling: 90 min). The claim-time token covers the clone; the
 * runner calls THIS immediately before its publish step for a fresh push
 * token. Workspace comes from the bearer key — never the caller. The
 * response also carries the bot commit identity so pushed commits render
 * as <slug>[bot] (falls back to the historical neutral identity when the
 * App env is absent, e.g. a partially configured self-host).
 */
export async function POST(request: NextRequest) {
  const auth = await requireBearer(request);
  if (auth instanceof NextResponse) return auth;

  const token = await getInstallationToken(auth.workspaceId);
  if (!token) {
    return NextResponse.json(
      { error: "no GitHub App installation for this workspace" },
      { status: 409 }
    );
  }
  const cfg = resolveGithubAppConfig(process.env);
  const identity = cfg.ok
    ? botCommitIdentity(cfg.slug, cfg.botUserId)
    : { name: "AgentRail Runner", email: "runner@agentrail.dev" };
  return NextResponse.json({
    github_token: token,
    bot_name: identity.name,
    bot_email: identity.email,
  });
}
```

- [ ] **Step 3: Python client — failing test first.** Extend `agentrail/tests/runner/test_client.py` with the `FakeTransport` pattern:

```python
def test_git_token_posts_and_parses_grant():
    transport = FakeTransport([
        Response(status=200, body=json.dumps({
            "github_token": "ghs_fresh",
            "bot_name": "jace[bot]",
            "bot_email": "98765+jace[bot]@users.noreply.github.com",
        }).encode("utf-8"))
    ])
    grant = _client(transport).git_token()
    assert grant is not None
    assert grant.token == "ghs_fresh"
    assert grant.bot_name == "jace[bot]"
    call = transport.calls[0]
    assert call["method"] == "POST"
    assert call["url"].endswith("/api/v1/runner/git-token")
    assert call["headers"]["Authorization"] == "Bearer rt_secret"


def test_git_token_returns_none_on_409_and_on_transport_error():
    assert _client(FakeTransport([Response(status=409, body=b"{}")])).git_token() is None

    def boom(*a, **k):
        raise OSError("down")
    assert _client(boom).git_token() is None
```
(Match `_client`/`Response` helper names to what that test file actually defines.)

Implement on `RunnerClient` (follow `report_result`'s shape):

```python
@dataclass(frozen=True)
class GitTokenGrant:
    """A fresh publish-time git credential + the bot commit identity."""
    token: str
    bot_name: str
    bot_email: str


    def git_token(self) -> Optional["GitTokenGrant"]:
        """Fetch a fresh installation token right before publish (spec §6).

        Best-effort by design: any failure returns None and the publish
        proceeds with the claim-time token — a short run's token is still
        valid, and a long run's expired token surfaces as the same git auth
        failure it would have anyway.
        """
        url = f"{self._base}/api/v1/runner/git-token"
        try:
            resp = self._transport("POST", url, headers=self._headers(), body=b"{}")
        except Exception:
            return None
        if resp.status != 200:
            return None
        try:
            data = json.loads(resp.body.decode("utf-8"))
        except Exception:
            return None
        token = str(data.get("github_token") or "")
        if not token:
            return None
        return GitTokenGrant(
            token=token,
            bot_name=str(data.get("bot_name") or "AgentRail Runner"),
            bot_email=str(data.get("bot_email") or "runner@agentrail.dev"),
        )
```

- [ ] **Step 4: Thread the refresh callable.** In `_make_execute` (runner.py) — it has `creds` in scope; build a client and pass a refresh callable through to the sandbox runner kwargs:

```python
        refresh_client = RunnerClient(
            base_url=creds.base_url, token=creds.token, workspace_id=creds.workspace_id
        )
        kwargs["git_token_refresh"] = refresh_client.git_token
```
(Add next to the existing `run_env` construction; `select_sandbox_runner` runners receive `**kwargs`, and `run_issue_on_host` gains the new optional param — default `None` keeps every existing caller/test working. Fleet inherits automatically since it reuses `_make_execute` unchanged.)

Extend `test_execute_github_token.py`: assert `fake.calls[0]` kwargs include a callable `git_token_refresh` (extend `_FakeRunner.__call__` to record `**_kw`).

- [ ] **Step 5: Re-mint in `_publish_green`.** Change signatures:
- `run_issue_on_host(..., git_token_refresh=None)`; pass `repo_url=repo_url, git_token_refresh=git_token_refresh` into `_publish_green`.
- `_publish_green(runner, repo_dir, issue_ref, pr_title, *, base_ref, env, repo_url="", git_token_refresh=None)`.

Inside `_publish_green`, before the `checkout -B` step:

```python
    # Publish-time credential refresh (spec §6): the claim-time installation
    # token lives 1 hour and this publish runs AFTER the whole agent run — it
    # may be stale. The clone baked the old token into origin's URL
    # (clone_auth.authenticated_clone_url), so a fresh token must be re-pointed
    # with `git remote set-url`, and GH_TOKEN updated for `gh pr create`.
    # Best-effort: no grant -> push proceeds on the claim-time token.
    identity = list(_GIT_IDENTITY)
    if git_token_refresh is not None:
        grant = None
        try:
            grant = git_token_refresh()
        except Exception:  # noqa: BLE001 — publish is best-effort
            grant = None
        if grant is not None and grant.token:
            env = dict(env)
            env["GH_TOKEN"] = grant.token
            if repo_url:
                _run_setup = runner.run(
                    ["git", "remote", "set-url", "origin",
                     authenticated_clone_url(repo_url, grant.token)],
                    cwd=str(repo_dir), env=env, timeout=120,
                    capture_output=True, text=True,
                )
            identity = [
                "-c", f"user.email={grant.bot_email}",
                "-c", f"user.name={grant.bot_name}",
            ]
```
Then replace every `*_GIT_IDENTITY` usage in the function with `*identity`. Import `authenticated_clone_url` (already imported at module top via the clone_auth re-export — verify the exact imported name at lines 48-57 and reuse it).

Extend `test_native_runner.py`'s green-path test with a variant: a `git_token_refresh` stub returning a grant → assert the scripted `FakeRunner` saw (a) a `git remote set-url origin https://x-access-token:ghs_fresh@…` call before push, (b) commit argv containing `user.name=jace[bot]`, (c) the `gh pr create` call's env carries `GH_TOKEN == "ghs_fresh"`. Also a no-refresh variant asserting byte-identical legacy behavior (no set-url call, `AgentRail Runner` identity).

- [ ] **Step 6: Run all touched suites**

Run: `cd apps/console && npx vitest run app/api/v1/runner/git-token && cd ../.. && python -m pytest -q agentrail/tests/runner/test_client.py agentrail/tests/runner/test_execute_github_token.py agentrail/tests/sandbox/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/console agentrail
git commit -m "feat(runner): publish-time git-token re-mint + jace[bot] commit identity"
```

---

### Task 8: Python token seam — `token_provider` mints installation tokens

**Files:**
- Read first: `agentrail/heartbeat/token_provider.py` (the current accounts-table SQL read — not captured in recon; read it fully before editing)
- Create: `agentrail/github_app.py`
- Modify: `agentrail/heartbeat/token_provider.py`
- Modify: `agentrail/cli/commands/issue.py` (doc-comments only — the `_GH_TOKEN_ENV` env-first precedence stays for self-host/PAT use)
- Modify: `pyproject.toml` (add `PyJWT` + `cryptography` IF absent — check `[project] dependencies` first; `cryptography` may already be present transitively but must be a direct dep if imported)
- Test: `agentrail/tests/test_github_app.py`, plus the existing token_provider/heartbeat tests (find them: `grep -rln token_provider agentrail/tests`)

**Interfaces:**
- Consumes: `workspaces.github_installation_id` column (Task 2's migration); env `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`.
- Produces:
  - `agentrail/github_app.py`: `sign_app_jwt(app_id: str, private_key_pem: str, now: int | None = None) -> str`; `mint_installation_token(installation_id: str, *, app_id: str, private_key_pem: str, transport=None) -> str | None` (None on any failure, never raises; transport injectable like `RunnerClient`).
  - `token_provider.get_github_token(workspace_id, executor)` keeps its exact signature but resolves: (1) read `github_installation_id` from `workspaces` via the executor; (2) mint via `github_app.mint_installation_token` with env config; (3) return None when unbound/unconfigured/mint-failed. The old accounts-table SQL is deleted.

- [ ] **Step 1: Failing tests for the JWT + mint module** (`agentrail/tests/test_github_app.py`): generate an RSA key in-test (`cryptography.hazmat.primitives.asymmetric.rsa`), assert `sign_app_jwt` payload fields (`iss`, `iat = now-60`, `exp = now+540`) by decoding with `jwt.decode(..., options={"verify_signature": True}, algorithms=["RS256"], audience=None)` against the public key; assert `mint_installation_token` builds `POST https://api.github.com/app/installations/{id}/access_tokens` with `Authorization: Bearer <jwt>` via an injected fake transport, returns the token string on 201-shaped success and None on 404/exception.
- [ ] **Step 2: Implement `agentrail/github_app.py`** with PyJWT (`jwt.encode({"iss":…, "iat":…, "exp":…}, private_key_pem, algorithm="RS256")`), normalizing literal `\n` in the PEM like the TS side, and a urllib-based default transport mirroring `agentrail/runner/client.py`'s `_urllib_transport`. Closed-union behavior: return `None`, never raise, never include the key or token in any exception/log.
- [ ] **Step 3: Rewrite `token_provider.get_github_token`** to the three-step resolution above, preserving its signature and its callers' None-handling. Update its docstring: this is the single Python GitHub-credential seam (spec §7 second rider); env `GITHUB_OAUTH_TOKEN` precedence in `issue.py` remains for explicit self-host PAT use, but hosted deployments leave it unset. Update the SQL: `SELECT github_installation_id FROM workspaces WHERE id = %s` through the same executor seam the old accounts join used.
- [ ] **Step 4: Update existing token_provider/heartbeat tests** — they currently fake the accounts join; re-point fixtures at the workspaces read + fake mint (monkeypatch `agentrail.github_app.mint_installation_token`).
- [ ] **Step 5: Run**

Run: `python -m pytest -q agentrail/tests/test_github_app.py $(grep -rln token_provider agentrail/tests)`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agentrail pyproject.toml
git commit -m "feat(python): token_provider mints App installation tokens — heartbeat + issue fallback covered"
```

---

### Task 9: Delete `getGithubToken`, docs + env rewrite, full sweep

**Files:**
- Modify: `packages/db-postgres/src/queries/index.ts` (delete the function), `packages/db-postgres/src/__tests__/github-token-query.test.ts` (delete file)
- Modify: `deploy/.env.production.example` (GitHub sections rewrite: lines ~44-52, ~130-137)
- Modify: `deploy/README.md` (if it documents OAuth App registration — check and update)
- Sweep: `grep -rn "getGithubToken" apps packages agentrail --include="*.ts" --include="*.tsx" --include="*.py" | grep -v node_modules | grep -v worktrees` must return ZERO production hits.

**Interfaces:** consumes everything prior; produces the clean cutover.

- [ ] **Step 1: Delete `getGithubToken`** from `queries/index.ts` (the whole function + doc-comment) and delete its test file. Run `pnpm --filter @agentrail/db-postgres build` — the compiler enumerates any missed reader; fix each by swapping to `getInstallationToken` (there should be none if Tasks 5-6 were complete).
- [ ] **Step 2: Rewrite `deploy/.env.production.example`.** Replace the OAuth App block (lines 44-52) with the `GITHUB_APP_*` sextet + a registration checklist comment:

```
# REQUIRED. The Jace GitHub App — YOU MUST REGISTER THIS ONCE. Register at
# https://github.com/settings/apps -> "New GitHub App":
#   Homepage URL:       https://<your-domain>
#   Callback URL:       https://<your-domain>/api/auth/callback/github
#   Setup URL:          https://<your-domain>/api/v1/connectors/github/install-callback
#     ("Redirect on update" checked; Webhook -> Active UNCHECKED)
#   Repository permissions: Contents RW, Pull requests RW, Issues RW,
#     Webhooks RW, Administration RW, Checks RO (Metadata RO is automatic)
#   Account permissions: Email addresses RO
#   Where can it be installed: Any account
# After creating: App ID + slug are on the App page; generate a client
# secret and a private key (.pem) there too. Bot user id:
#   curl -s https://api.github.com/users/<slug>%5Bbot%5D | jq .id
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_BOT_USER_ID=
```
Replace the `GITHUB_OAUTH_TOKEN`/`GITHUB_TOKEN` block (lines ~130-137) with:
```
# LEGACY / self-host only. Hosted deployments MUST leave these unset — every
# hosted GitHub call now rides the App installation token (minted per
# workspace from GITHUB_APP_* above; see the spec:
# docs/superpowers/specs/2026-07-24-jace-github-app-identity-design.md).
# A self-hosted single-tenant install MAY still set a PAT here as the CLI's
# explicit-token override (agentrail/cli/commands/issue.py reads it first).
# GITHUB_OAUTH_TOKEN=
# GITHUB_TOKEN=
```
- [ ] **Step 3: Sweep + full test run**

Run: the grep sweep above (expect zero hits), then `pnpm --filter @agentrail/github-app test && pnpm --filter @agentrail/db-postgres build && pnpm --filter @agentrail/db-postgres test && cd apps/console && npx vitest run && cd ../.. && python -m pytest -q`
Expected: everything green; sweep empty.

- [ ] **Step 4: Commit**

```bash
git add packages/db-postgres deploy
git commit -m "feat(cutover): delete getGithubToken — GitHub App installation tokens are the only credential"
```

---

## Post-merge deploy checklist (owner actions — not agent tasks)

1. Register the App per the Task 9 env-example checklist (or edit the already-created App: add Webhooks RW, Administration RW, Email addresses RO; set the Setup URL; uncheck webhook Active).
2. Set the six `GITHUB_APP_*` vars on the console Railway/compose env; unset `GITHUB_OAUTH_TOKEN`/`GITHUB_TOKEN` on hosted services; retire `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`.
3. Deploy (migration 0043 auto-applies via the migrate service).
4. Every existing workspace: click Connect GitHub once (Connectors page).
5. End-to-end check: fresh sign-in shows "Authorize Jace"; install flow completes; Jace reviews a PR as `jace[bot]`; a run's pushed commits show the bot identity.
