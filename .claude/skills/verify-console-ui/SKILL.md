---
name: verify-console-ui
description: Browser-verify an authenticated AgentRail console (dashboard) page or API route in dev WITHOUT doing GitHub OAuth, by minting a Postgres session row + cookie. Use when verifying a console UI change, a (dashboard) page, or a console API route locally — CI skips console tests, so UI changes must be browser-verified before merge.
---

# Verify an authed console page in dev

The console uses NextAuth with the Drizzle **database-session strategy**, GitHub OAuth only (`packages/auth/src/index.ts` → `sessionsTable: sessions`). To verify an authenticated `(dashboard)` page without OAuth, mint a session row and hit it with the cookie.

## Dev environment (fixed values)
- Postgres: `127.0.0.1:5434`, creds `agentrail:agentrail` (NOT the migrate default 5432). ClickHouse: `localhost:8123`, same creds. See `apps/console/.env.local`.
- Console dev server usually already on `:3000`.
- Dev user `codex-local@example.com` = `00000000-0000-0000-0000-000000000002`, owner of workspace `00000000-0000-0000-0000-000000000001` (slug `dev`).

## Steps
1. **Rebuild dist if you touched a package's schema/queries.** The console imports the BUILT `dist/` of `@agentrail/db-postgres` — a stale build gives `X is not a function` 500s with empty bodies. `npm run build` the package first. See `workspace-package-dist-staleness`.
2. **Mint a session:**
   `INSERT INTO sessions (session_token, user_id, expires) VALUES ('<token>', '00000000-0000-0000-0000-000000000002', now()+interval '2 hours');`
3. **Render server components directly:**
   `curl -s -b "authjs.session-token=<token>" http://localhost:3000/dashboard/00000000-0000-0000-0000-000000000001/...` — returns fully-rendered HTML, so you can grep visible text. API routes accept the same cookie for end-to-end POST/PATCH checks.
4. **Seed fixtures precisely** (e.g. ClickHouse `INSERT INTO failure_events ...`) and clean up by the EXACT id you inserted.
5. For visual/interaction checks, use the preview tools (`preview_start`, `preview_snapshot`, `preview_screenshot`) against `:3000` with the cookie set.

## Hard safety rule
**NEVER `DELETE` from a live table by a shared name/label.** Cleanup that matched `name='Self-hosted runner'` once wiped the user's real device-flow login token (every runner token shares that name) → `agentrail runner` got 401. Delete ONLY by the exact primary key you just inserted; never touch other `sessions` rows for the dev user — several belong to other work. See `test-cleanup-deleted-user-data`.

## Quality check
When asserting UI is correct, prefer rendered names over raw UUIDs/run_ids/hashes — the UI should show names and use the id only as an href (`ui-prefer-names-over-ids`). NextAuth may rotate/clear your minted session on use — that's expected.

## Stopping condition
The change is verified when the curl/preview output contains the expected rendered text (not a 500/empty body), and every seeded fixture and session row you created has been deleted by exact id.
