# Jace as a GitHub App — design

**Date:** 2026-07-24
**Status:** Draft for review
**Owner:** bensigo
**Related:** `docs/superpowers/specs/2026-07-08-cloud-multitenant-jace-design.md` §5/§12 — this spec implements the "GitHub App migration for short-lived, narrow installation tokens" item that spec explicitly deferred to a separate arc.

## 1. Problem

A friend testing sign-up reported the GitHub authorization screen said "Allow bensigo" instead of showing Jace as its own identity. Root-cause investigation traced this to a structural gap, not a display bug:

- Console sign-in (`packages/auth/src/index.ts`) registers a classic **OAuth App** via `next-auth/providers/github` — confirmed by its client ID prefix (`Ov23…`; a GitHub App's would be `Iv23…`). It requests `read:user user:email repo` scope at login.
- That same login-time `access_token` (stored in `accounts.access_token` by the NextAuth/Drizzle adapter) is then reused as the credential for every GitHub write Jace performs. `packages/db-postgres/src/queries/index.ts`'s `getGithubToken(workspaceId)` is the single source of that token, read by **8 call sites**: PR review posting, PR merge, git push / PR creation (via the AFK runner), repo listing + webhook registration, run-result posting, and GitHub issue creation (failures, review-gates).
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

## 3. GitHub App registration

One App, named **Jace**, permissions scoped to exactly what the 8 call sites already do — nothing padded in:

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | git clone / push |
| Pull requests | Read & write | read diff, post review, merge |
| Issues | Read & write | create issues (failures, review-gates) |
| Checks | Read-only | CI-status reconciliation reads check-runs |
| Metadata | Read | mandatory baseline |

No webhook subscription is configured in this pass (see §9) — the App's webhook is left inactive/pointed at a placeholder during registration.

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
3. GitHub redirects back to a new callback route (e.g. `GET /api/v1/workspaces/[workspaceId]/connectors/github/install-callback`) with `installation_id` and the `state` value.
4. The callback verifies `state` against the signed workspaceId, then stores `installation_id` on the workspace (new column `workspaces.githubInstallationId`, following the existing flat-column convention on that table — e.g. `discordWebhookUrl`).
5. Repo listing (`runner/repos/route.ts`, currently `GET /user/repos` with the personal token) switches to `GET /installation/repositories` using the installation token — this also naturally scopes the list to exactly the repos the owner granted, rather than everything their personal account can see. The existing `repositories` table (per-workspace connected repos) is populated from this list the same way it is today; no schema change needed there.

## 6. Installation-token minting

New package `packages/github-app` (mirrors the existing `packages/auth` split), exporting:

```
getInstallationToken(workspaceId: string): Promise<string>
```

Implementation: look up `githubInstallationId` for the workspace → sign an App JWT (RS256, 10-minute expiry per GitHub's requirement, using `GITHUB_APP_PRIVATE_KEY`) → `POST https://api.github.com/app/installations/{id}/access_tokens` with that JWT as bearer → return the resulting `ghs_…` token. Same string-token contract as today's `getGithubToken`, so call sites swap in directly.

## 7. Call-site migration

All 8 current `getGithubToken(workspaceId)` call sites move to `getInstallationToken(workspaceId)`:

| File | What it does |
|---|---|
| `apps/console/app/api/v1/runner/pr-review/route.ts` | fetch PR diff, post review comments |
| `apps/console/lib/github-merge.ts` | squash-merge a PR |
| `apps/console/app/api/v1/runner/claim/route.ts` | hands the runner a token for `git clone`/`push`/`gh pr create` |
| `apps/console/app/api/v1/runner/repos/route.ts` | list repos, register repo webhook |
| `apps/console/app/api/v1/runner/result/route.ts` | post run results |
| `apps/console/app/api/v1/workspaces/[workspaceId]/connectors/github/webhook/route.ts` | register repo webhook (intake mechanism itself untouched, see §9) |
| `apps/console/app/api/v1/workspaces/[workspaceId]/failures/[failureId]/issue/route.ts` | create a GitHub issue for a failure |
| `apps/console/app/api/v1/workspaces/[workspaceId]/review-gates/[gateId]/issue/route.ts` | create a GitHub issue for a review gate |
| `packages/db-postgres/src/queries/ci-reconcile.ts` | read PR/check-run status for CI reconciliation |

**One fix rides along with this migration:** `agentrail/sandbox/native_runner.py:667-670` hardcodes the git commit identity as `user.name="AgentRail Runner"` / `user.email="runner@agentrail.dev"`. For pushed commits to actually render as Jace (not just be attributed via the API token on the PR/review side), this becomes the standard GitHub App bot-commit identity: `user.name="jace[bot]"`, `user.email="<GITHUB_APP_ID>+jace[bot]@users.noreply.github.com"` — this is also what makes GitHub render the "Verified" bot badge. `clone_auth.py` and the rest of the token-threading path (`agentrail/cli/commands/runner.py`) need no changes — they only carry whatever token string `runner/claim` hands them.

## 8. Cutover & migration

Ships as a clean cutover, not a gradual rollout:

- `getGithubToken` is deleted outright in the same change that introduces `getInstallationToken` — no code path silently falls back to it.
- Any workspace without a `githubInstallationId` gets a clear, actionable error ("Connect GitHub to let Jace work on this repo") instead of a confusing failure deep in a GitHub API call.
- Every existing connected workspace, including the owner's own, must click "Connect GitHub" once post-deploy. Given how few workspaces are connected today, this is a small, known-bounded list, not a mass-migration problem.

## 9. Out of scope / follow-ups

- **App-level webhook consumption** (live `installation.deleted`/`installation_repositories.removed` handling) — deferred in favor of lazy detection (§2); would let uninstalls surface immediately instead of on next use.
- **Consolidating issue-intake onto the App's own webhook events**, replacing the current per-workspace webhook + skippable-global-secret fallback — a real gap (already flagged in the earlier spec) but a separate, already-working system; not touched here.
- **Installation-token caching** — add if mint-per-call starts hitting GitHub's rate limits in practice.
- **Self-host documentation** for registering an operator's own GitHub App — the code is env-var configurable (§3) but a walkthrough doc is a separate, small follow-up.

## 10. Testing

- Unit tests for JWT signing and installation-token minting, with GitHub's token endpoint mocked.
- Integration test against a real test App installation in CI where feasible; otherwise mocked at the same boundary as the unit tests.
- Manual end-to-end check post-deploy: fresh sign-in shows "Authorize Jace" on the consent screen, "Connect GitHub" install flow completes, Jace opens/reviews a real PR, and the review/push/issue shows up on GitHub attributed to `jace[bot]`.
