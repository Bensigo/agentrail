/**
 * The SAFETY SEAM for console chat (#1288): whether the `/chat` dashboard
 * surface, its send/poll API routes, and the sidebar entry point exist at
 * all for a given workspace. OFF by default, everywhere — this repo's rule
 * is flags default OFF (see `alignment/feature-flags.ts`'s own precedent,
 * `isModelSelectionLearningEnabled`, which this mirrors verbatim).
 *
 * Two knobs, both env-driven — no DB column, migration, or admin UI in this
 * PR (a real per-workspace toggle with a UI is left to a later PR, same
 * posture `alignment/feature-flags.ts` documents for its own flag):
 *
 *   - `CONSOLE_CHAT_ENABLED=true` (or `1`) — global switch, every workspace.
 *   - `CONSOLE_CHAT_WORKSPACES` — comma-separated workspace ids, ADDITIVE to
 *     the global switch (a targeted rollout to specific workspaces without
 *     flipping it on everywhere).
 *
 * Neither var set (the out-of-the-box state) -> disabled everywhere.
 */

/**
 * The subset of `process.env` this module reads — injectable for tests so
 * they never need to mutate the real `process.env`. The index signature
 * (rather than JUST the two named optional props) is required for
 * `process.env` itself (`NodeJS.ProcessEnv`) to satisfy this type as the
 * default parameter value below.
 */
export interface ConsoleChatFeatureFlagEnv {
  CONSOLE_CHAT_ENABLED?: string | undefined;
  CONSOLE_CHAT_WORKSPACES?: string | undefined;
  [key: string]: string | undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Whether console chat is enabled for `workspaceId`. `env` defaults to the
 * real `process.env`; pass a fake object in tests.
 */
export function isConsoleChatEnabled(
  workspaceId: string | null | undefined,
  env: ConsoleChatFeatureFlagEnv = process.env
): boolean {
  if (isTruthyFlag(env.CONSOLE_CHAT_ENABLED)) return true;
  if (!workspaceId) return false;

  const allowlist = env.CONSOLE_CHAT_WORKSPACES;
  if (!allowlist) return false;

  return allowlist
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .includes(workspaceId);
}
