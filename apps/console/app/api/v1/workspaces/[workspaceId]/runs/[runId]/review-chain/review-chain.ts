import { parseGithubPrUrl } from "../../../../../../../../lib/github-merge";

export type ReviewChainPrResolution =
  | {
      state: "resolved";
      repo: string;
      number: number;
    }
  | {
      state: "no_pr";
      repo: null;
      number: null;
    }
  | {
      state: "unknown";
      repo: null;
      number: null;
      reason?: "malformed_pr_url" | "missing_trusted_repository" | "repository_mismatch";
    };

/**
 * Resolve a run's PR URL into the repo slug + PR number the chain queries need.
 * Empty / absent input is a real "no PR" state; malformed or foreign URLs stay
 * explicitly "unknown" so the route never guesses.
 */
export function resolveReviewChainPr(
  prUrl: string | null | undefined
): ReviewChainPrResolution {
  if (!prUrl) {
    return { state: "no_pr", repo: null, number: null };
  }

  const parsed = parseGithubPrUrl(prUrl);
  if (!parsed) {
    return { state: "unknown", repo: null, number: null, reason: "malformed_pr_url" };
  }

  return {
    state: "resolved",
    repo: `${parsed.owner}/${parsed.repo}`,
    number: parsed.number,
  };
}
