"use server";

import { signIn, GITHUB_REPO_SCOPE } from "@agentrail/auth";

/**
 * Incremental OAuth escalation (#1294 AC2). Re-runs GitHub OAuth requesting the
 * full `repo` scope on top of the identity scopes the user already granted at
 * sign-in. For an identity-only user this is the first time GitHub shows the
 * `repo` consent; on return, the auth `signIn` callback persists the widened
 * scope + fresh access token onto the user's `accounts` row, so the connect
 * flow then succeeds. The user lands back on the repos page, where re-opening
 * "Add repository" now loads the picker.
 *
 * `signIn`'s third argument is `authorizationParams` — its `scope` overrides the
 * provider's identity-only default for this one authorization request.
 */
export async function grantGithubRepoAccess(
  workspaceId: string
): Promise<void> {
  await signIn(
    "github",
    { redirectTo: `/dashboard/${workspaceId}/repos` },
    { scope: GITHUB_REPO_SCOPE }
  );
}
