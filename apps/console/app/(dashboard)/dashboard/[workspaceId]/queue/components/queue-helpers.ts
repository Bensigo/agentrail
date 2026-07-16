/**
 * Re-exports the shared state vocabulary for the (now redirect-only) Issue
 * Queue page and its components. The implementation moved to
 * `apps/console/lib/work-vocabulary.ts` (#1231) so the API route
 * (`api/v1/workspaces/[workspaceId]/queue/route.ts`) no longer has to import
 * across a page-directory boundary. This file stays as a thin compatibility
 * shim — no behavior change — so `queue-table.tsx`, `queue-state-badge.tsx`,
 * and `queue-helpers.test.ts` keep working unmodified.
 */
export * from "../../../../../../lib/work-vocabulary";
