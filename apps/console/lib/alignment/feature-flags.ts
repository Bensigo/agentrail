/**
 * The SAFETY SEAM for the model-selection learning loop (#1338 PR②):
 * whether `selectExecuteModel` (`selector.ts`) runs at all for a given
 * workspace, or whether the brief-composition path keeps using the static
 * `MODEL_CATALOG[taskType]` pick exactly as it did before this PR existed.
 *
 * OFF by default, everywhere, until someone deliberately sets one of the
 * two env vars below — turning it ON in production is explicitly PR③'s
 * job, not this one's. `estimate.test.ts` / `alignment-brief.test.ts` pin
 * the flag-off path as byte-identical to the pre-#1338 static behavior.
 *
 * Two knobs, both env-driven — no DB column, migration, or admin UI in
 * THIS PR (a real per-workspace toggle with a UI is left to a later PR,
 * exactly like `hostedExecution`/`requireAlignment`/`mergePermission`
 * shipped "the column + enforcement, no UI yet" before their own admin
 * surfaces existed — this PR doesn't even need the column yet):
 *
 *   - `MODEL_SELECTION_LEARNING_ENABLED=true` (or `1`) — global switch,
 *     every workspace.
 *   - `MODEL_SELECTION_LEARNING_WORKSPACES` — comma-separated workspace
 *     ids, ADDITIVE to the global switch (a targeted rollout to specific
 *     workspaces without flipping it on everywhere).
 *
 * Neither var set (the out-of-the-box state) -> disabled everywhere, for
 * every workspace, including one with no `workspaceId` at all (a
 * chat-identity-only session that hasn't graduated to a workspace yet).
 */

/**
 * The subset of `process.env` this module reads — injectable for tests so
 * they never need to mutate the real `process.env`. The index signature
 * (rather than JUST the two named optional props) is required for
 * `process.env` itself (`NodeJS.ProcessEnv`) to satisfy this type as the
 * default parameter value below — TypeScript's "weak type" check would
 * otherwise reject it as sharing no DECLARED property with `ProcessEnv`'s
 * own index signature.
 */
export interface FeatureFlagEnv {
  MODEL_SELECTION_LEARNING_ENABLED?: string | undefined;
  MODEL_SELECTION_LEARNING_WORKSPACES?: string | undefined;
  [key: string]: string | undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Whether the model-selection learning loop is enabled for `workspaceId`.
 * `env` defaults to the real `process.env`; pass a fake object in tests.
 */
export function isModelSelectionLearningEnabled(
  workspaceId: string | null | undefined,
  env: FeatureFlagEnv = process.env
): boolean {
  if (isTruthyFlag(env.MODEL_SELECTION_LEARNING_ENABLED)) return true;
  if (!workspaceId) return false;

  const allowlist = env.MODEL_SELECTION_LEARNING_WORKSPACES;
  if (!allowlist) return false;

  return allowlist
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .includes(workspaceId);
}
