# Jace as a GitHub App — design

**Date:** 2026-07-24
**Status:** Draft for review
**Owner:** bensigo
**Related:** `docs/superpowers/specs/2026-07-08-cloud-multitenant-jace-design.md` §5/§12 — this spec implements the "GitHub App migration for short-lived, narrow installation tokens" item that spec explicitly deferred to a separate arc.

## 1. Problem

A friend testing sign-up reported the GitHub authorization screen said "Allow bensigo" instead of showing Jace as its own identity. Root-cause investigation traced this to a structural gap, not a display bug:

- Console sign-in (`packages/auth/src/index.ts`) registers a classic **OAuth App** via `next-auth/providers/github` — confirmed by its client ID prefix (`Ov23…`; a GitHub App's would be `Iv23…`). It requests `read:user user:email repo` scope at login.
- That same login-time `access_token` (stored in `accounts.access_token` by the NextAuth/Drizzle adapter) is then reused as the credential for every GitHub write Jace performs. `packages/db-postgres/src/queries/index.ts`'s `getGithubToken(workspaceId)` is the single source of that token, read across nine files: PR review posting, PR merge, git push / PR creation (via the AFK runner), repo listing + creation + webhook registration, run-result posting, CI reconciliation, and GitHub issue creation (failures, review-gates).
- A personal OAuth App token is a **user-to-server** token — GitHub always attributes the resulting API calls to whichever human authorized it. There is no way for it to show up as a separate "Jace" identity, renaming the OAuth App would only fix the consent-screen text, not attribution on reviews/pushes/issues.
- No GitHub App registration, installation flow, or installation-token minting exists anywhere in the repo today.

**Goal:** register Jace as a real GitHub App with its own bot identity (`jace[bot]`), and move every GitHub write Jace performs onto that identity — both the login consent screen and the actual actions.

## 2. Decisions locked (brainstorm 2026-07-24)

| Decision | Choice |
|---|---|
| Cutover strategy | **Clean cutover, no dual-support.** `getGithubToken` is deleted, not deprecated-in-place. Every existing connected workspace (including the owner's own) must re-run "Connect GitHub" once after deploy. |
| Self-host | App credentials are env-var configurable (`GITHUB_APP_*`), not hardcoded to AgentRail's own App — self-hosted operators register and configure their own App, same pattern as other channels' bot tokens. |
| Login flow | Console sign-in **also** switches to the App's own OAuth (same App, not a second registration) — fixes the exact consent screen the friend saw, and drops the `repo` scope from login entirely. |
| Issue-intake webhook | **Untouched.** The existing per-workspace webhook (secret validation, polling/enqueue mechanism) is not consolidated onto the App's own webhook events in this pass — out of scope, see §9. |
| Uninstall detection | **Lazy.** No live App-webhook listener for `installation.deleted`; an uninstall surfaces as a failed token mint on next use, with a clear "reconnect GitHub" error. Revisit if that proves too slow to surface in practice. |
| Token caching | **None in v1.** `getInstallationToken` mints fresh on every call. Call volume (occasional review/push/issue actions) doesn't justify the cache-invalidation surface yet. |
| Runner token lifetime | **Publish-time re-mint.** Installation tokens live 1 hour; runs legitimately exceed that (the fleet stale-run ceiling is 90 minutes). The claim-time token covers the clone; the runner requests a fresh token immediately before its publish step via a new authenticated endpoint (§6). Without this, long runs fail at the final push with an expired credential. |
| `create_repo` tool | **Guided link + org support** (decision 2026-07-24, revised after verification). GitHub structurally blocks every GitHub App token kind — installation AND user access — from `POST /user/repos`; personal-account repo creation is simply not exposed to Apps (community discussions [65724](https://github.com/orgs/community/discussions/65724), [116331](https://github.com/orgs/community/discussions/116331), [171040](https://github.com/orgs/community/discussions/171040), unresolved since 2023). Personal-account workspaces: Jace replies with a prefilled `github.com/new` link plus the App install link. Org-account installations: direct creation via `POST /orgs/{org}/repos` with the installation token (requires the Administration permission, §3). |

## 3. GitHub App registration

One App, named **Jace**, permissions scoped to exactly what the migrated call sites do — nothing padded in:

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | git clone / push |
| Pull requests | Read & write | read diff, post review, merge |
| Issues | Read & write | create issues (failures, review-gates) |
| Webhooks | Read & write | register per-repo issue-intake webhooks (`POST /repos/{repo}/hooks`, in `runner/repos` and `connectors/github/webhook` routes) — **without this, the kept-as-is intake registration 403s on day one** |
| Administration | Read & write | org-account repo creation only (`POST /orgs/{org}/repos`, §2 `create_repo` row); personal-account creation is structurally unavailable to Apps |
| Checks | Read-only | CI-status reconciliation reads check-runs |
| Metadata | Read | mandatory baseline |

Plus one **account** permission: **Email addresses: Read-only** — NextAuth's GitHub provider falls back to `GET /user/emails` when the profile email is private; without this permission that call 403s and new users land with null emails (`users.email` is nullable so nothing crashes, but it's a silent regression).

If the App was already registered before this table was finalized, edit its permissions to match — before any installations exist, permission changes apply with zero approval friction.

No webhook subscription is configured in this pass (see §9) — the App's webhook is left inactive during registration.

New env vars (parallel naming to the existing `GITHUB_CLIENT_ID`/`GITHUB_WEBHOOK_SECRET` convention in `deploy/.env.production.example`):

- `GITHUB_APP_ID` — the App's numeric ID
- `GITHUB_APP_SLUG` — used to build the install URL (`github.com/apps/<slug>/installations/new`)
- `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` — used for the login OAuth flow
- `GITHUB_APP_PRIVATE_KEY` — signs the JWTs used to mint installation tokens

`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (the old OAuth App) are retired once the cutover ships.

## 4. Login flow

`packages/auth/src/index.ts`'s `GitHub(...)` provider config changes:

- `clientId`/`clientSecret` point at `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET` instead of the OAuth App's.
- The `authorization.params.scope` override is removed — GitHub Apps don't grant repo access via login-time OAuth scopes; access comes from the installation (§5).

The consent screen a new user sees now reads "Authorize Jace." `accounts.access_token`/`refresh_token` still get persisted by the Drizzle adapter as a side effect of NextAuth's OAuth flow, but nothing reads them anymore — they become inert login plumbing, not a credential. (The earlier spec's "encrypt GitHub OAuth tokens at rest" security item, `2026-07-08-cloud-multitenant-jace-design.md` §5, is not revisited here since the token these columns hold no longer carries repo access — tracked where it already lives, not duplicated in this spec.)

## 5. Connect GitHub (install) flow

A distinct step from login, surfaced in onboarding and workspace settings:

1. Workspace owner clicks "Connect GitHub" → redirected to `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new?state=<signed workspaceId>`.
2. Owner picks which repos to grant Jace access to, on GitHub's own installation UI.
3. GitHub redirects back to the App's **Setup URL** — one global route, `GET /api/v1/connectors/github/install-callback`, registered once on the App. It **cannot** be workspace-scoped (GitHub stores a single Setup URL), so the workspace identity travels exclusively in `state`, which GitHub passes through the install flow. Installs initiated directly from `github.com/apps/<slug>` (bypassing our button) arrive with no `state` at all — the callback renders a "finish connecting from your workspace settings" page for that case, never guessing a workspace.
4. The callback verifies `state` **against the caller's own authenticated session** — not merely well-formed — before writing anything: `state` must be minted server-side (signed/HMAC'd, short-lived) at step 1 for the specific workspace the signed-in user is a member of, and the callback re-checks that membership at redemption. This is the same class of cross-tenant-hijack risk this codebase's own reviews have caught before in adjacent flows (magic-link workspace binding); a client-suppliable or replayable `state` would let one workspace's install get bound to another. Only then is `installation_id` stored on the workspace (new column `workspaces.githubInstallationId`, following the existing flat-column convention on that table — e.g. `discordWebhookUrl`).
5. Repo listing (`runner/repos/route.ts`, currently `GET /user/repos` with the personal token) switches to `GET /installation/repositories` using the installation token — this also naturally scopes the list to exactly the repos the owner granted, rather than everything their personal account can see. The existing `repositories` table (per-workspace connected repos) is populated from this list the same way it is today; no schema change needed there.

## 6. Installation-token minting

New package `packages/github-app` (mirrors the existing `packages/auth` split), exporting:

```
getInstallationToken(workspaceId: string): Promise<string>
```

Implementation: look up `githubInstallationId` for the workspace → sign an App JWT (RS256, 10-minute expiry per GitHub's requirement, using `GITHUB_APP_PRIVATE_KEY`) → `POST https://api.github.com/app/installations/{id}/access_tokens` with that JWT as bearer → return the resulting `ghs_…` token. Same string-token contract as today's `getGithubToken`, so call sites swap in directly. (`clone_auth.py`'s existing `x-access-token:{token}@` clone-URL format works identically with `ghs_` tokens — no runner-side auth changes.)

**Token lifetime vs run duration:** installation tokens expire after **1 hour**, and runs can legitimately exceed that (fleet stale-run ceiling: 90 minutes). Console-side callers mint per call, so they have no expiry exposure — but the runner receives its token at claim time and pushes at the *end* of the run. So the runner protocol gains one endpoint: `POST /api/v1/runner/git-token` (same bearer auth as `claim`; workspace resolved server-side from the claimed run, never caller-supplied), which the runner calls immediately before its publish step to get a fresh push token. Claim continues to hand out a token too, so the clone works and short runs pay no extra round-trip.

## 7. Call-site migration

Every reader of `getGithubToken(workspaceId)` moves to `getInstallationToken(workspaceId)` — the old export is deleted in the same change, so the compiler enumerates the complete set rather than trusting this list. The known set today:

| File | What it does |
|---|---|
| `apps/console/app/api/v1/runner/pr-review/route.ts` | fetch PR diff, post review comments |
| `apps/console/lib/github-merge.ts` | squash-merge a PR |
| `apps/console/app/api/v1/runner/claim/route.ts` | hands the runner a token for `git clone`/`push`/`gh pr create` |
| `apps/console/app/api/v1/runner/repos/route.ts` | list repos (`GET /installation/repositories`), register repo webhook; repo **creation** splits per §2's `create_repo` row — org installations create via `POST /orgs/{org}/repos` with the installation token, personal accounts get the guided-link reply (`POST /user/repos` is structurally unavailable to Apps) |
| `apps/console/app/api/v1/runner/result/route.ts` | post run results |
| `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/webhook/route.ts` | register repo webhook (intake mechanism itself untouched, see §9) — note: a GitHub App would normally make per-repo webhook registration redundant (installed repos already push events to the App's own webhook), but per §2 this pass deliberately keeps the existing per-workspace webhook as-is, just re-pointed at the new token; consolidating onto the App's webhook is the §9 follow-up |
| `apps/console/app/api/v1/workspaces/[workspaceId]/failures/[failureId]/issue/route.ts` | create a GitHub issue for a failure |
| `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts` | create a GitHub issue for a review gate |
| `packages/db-postgres/src/queries/ci-reconcile.ts` | read PR/check-run status for CI reconciliation |

**One fix rides along with this migration:** `agentrail/sandbox/native_runner.py:667-670` hardcodes the git commit identity as `user.name="AgentRail Runner"` / `user.email="runner@agentrail.dev"`. For pushed commits to render as Jace on GitHub, this becomes the standard bot-commit identity: `user.name="jace[bot]"`, `user.email="<bot-user-id>+jace[bot]@users.noreply.github.com"` — where `<bot-user-id>` is the **bot user's numeric database id** (fetched once post-registration via `GET /users/jace[bot]`), NOT the App id; using the App id silently breaks the avatar/profile linkage (reference: `github-actions[bot]` uses its user id 41898282, not the Actions App id 15368). Honest scope note: commits created locally and pushed over git are not GitHub-signed, so they will **not** carry the "Verified" badge — the noreply identity buys correct *attribution* (bot name + avatar on every commit), which is the goal here. `clone_auth.py` and the rest of the token-threading path (`agentrail/cli/commands/runner.py`) need no changes — they only carry whatever token string the console hands them.

**Second rider — the Python `create_issue` env-token path.** `agentrail/cli/commands/issue.py` reads `GITHUB_OAUTH_TOKEN`/`GITHUB_TOKEN` from env, and `deploy/.env.production.example` documents that env var as the credential for Jace's `create_issue` → `agentrail issue create --connector github`. Left alone, issues filed through this path keep exactly the personal attribution this spec exists to kill. In this arc: the hosted deployment stops setting a personal token there, and the code path hosted Jace actually exercises must resolve its token from the console (installation token) instead of raw env — the exact seam is picked at implementation-plan time. Acceptance criterion: **no hosted code path posts to GitHub with a personal token.**

## 8. Cutover & migration

Ships as a clean cutover, not a gradual rollout:

- `getGithubToken` is deleted outright in the same change that introduces `getInstallationToken` — no code path silently falls back to it.
- Any workspace without a `githubInstallationId` gets a clear, actionable error ("Connect GitHub to let Jace work on this repo") instead of a confusing failure deep in a GitHub API call.
- Every existing connected workspace, including the owner's own, must click "Connect GitHub" once post-deploy. Given how few workspaces are connected today, this is a small, known-bounded list, not a mass-migration problem.
- A repo created through the org-path `create_repo` (or by hand via the guided link) is **not automatically part of the installation** when the owner chose "Only select repositories" at install time. After creation, Jace verifies the repo is reachable via `GET /installation/repositories`; if it isn't, he replies with the installation-settings link to add it — surfacing the gap immediately in chat rather than failing later mid-run.
- Existing users' console logins survive the credential swap untouched: the NextAuth provider key stays `"github"` and `providerAccountId` is the GitHub user id, both unchanged — existing `accounts` rows still match, nobody re-registers.

## 9. Out of scope / follow-ups

- **App-level webhook consumption** (live `installation.deleted`/`installation_repositories.removed` handling) — deferred in favor of lazy detection (§2); would let uninstalls surface immediately instead of on next use.
- **Consolidating issue-intake onto the App's own webhook events**, replacing the current per-workspace webhook + skippable-global-secret fallback — a real gap (already flagged in the earlier spec) but a separate, already-working system; not touched here.
- **Installation-token caching** — add if mint-per-call starts hitting GitHub's rate limits in practice.
- **Self-host documentation** for registering an operator's own GitHub App — the code is env-var configurable (§3) but a walkthrough doc is a separate, small follow-up.

## 10. Testing

- Unit tests for JWT signing and installation-token minting, with GitHub's token endpoint mocked.
- Install-callback tests: signed-`state` round-trip binds the right workspace; tampered/replayed `state` is rejected; a no-`state` direct install renders the finish-connecting page and writes nothing.
- Publish-time token tests: a long run whose claim-time token has expired gets a fresh token from `POST /api/v1/runner/git-token` before push; the endpoint resolves the workspace from the claimed run, never from caller input.
- `create_repo` split: org installation → API create via `POST /orgs/{org}/repos`; personal installation → guided-link reply with **zero** GitHub API calls.
- Integration test against a real test App installation in CI where feasible; otherwise mocked at the same boundary as the unit tests.
- Manual end-to-end check post-deploy: fresh sign-in shows "Authorize Jace" on the consent screen, "Connect GitHub" install flow completes, Jace opens/reviews a real PR, and the review/push/issue shows up on GitHub attributed to `jace[bot]`.
