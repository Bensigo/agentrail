import {
  getConnector,
  getInstallationToken,
  getApprovalById,
  getRepository,
} from "@agentrail/db-postgres";
import {
  buildDependencyUpgradeIssueBody,
  dependencyUpgradeApprovalReady,
  dependencyUpgradeProposalMatchesCandidate,
  type DependencyUpgradeCandidateInput,
  type DependencyUpgradeProposal,
} from "./dependency-upgrade-contract";

export type PublishedDependencyUpgradeIssue = {
  url: string;
  number: number;
  body: string;
  repoFullName: string;
};

function parseGithubSlug(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^(?:https?:\/\/|git@)github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export async function publishDependencyUpgradeIssue(input: {
  workspaceId: string;
  repositoryId: string;
  approvalId: string;
  contractId: string;
  candidate: DependencyUpgradeCandidateInput;
  proposal: DependencyUpgradeProposal;
  fetchImpl?: typeof fetch;
}): Promise<PublishedDependencyUpgradeIssue> {
  const approval = await getApprovalById(input.approvalId);
  if (
    !approval ||
    approval.workspaceId !== input.workspaceId ||
    approval.status !== "approved" ||
    approval.toolName !== "dependency_upgrade_contract" ||
    approval.dependencyContractId !== input.contractId
  ) {
    throw new Error("dependency-upgrade publication requires the approved candidate-bound Jace approval");
  }
  const repository = await getRepository(input.workspaceId, input.repositoryId);
  if (!repository) throw new Error("repository is not connected to this workspace");
  const slug = parseGithubSlug(repository.url);
  if (!slug) throw new Error("connected repository is not a GitHub repository");

  const token = await getInstallationToken(input.workspaceId);
  if (!token) throw new Error("GitHub is not connected for this workspace");

  const connector = await getConnector(input.workspaceId, "github");
  const triggerLabel = connector?.config?.triggerLabel || "ready-for-agent";
  const proposal = input.proposal;
  if (!dependencyUpgradeProposalMatchesCandidate(proposal, input.candidate)) {
    throw new Error("dependency-upgrade proposal is not bound to the observed candidate");
  }
  if (!dependencyUpgradeApprovalReady(proposal)) {
    throw new Error("dependency-upgrade proposal is not approved for publication");
  }
  const issueBody = buildDependencyUpgradeIssueBody(proposal);
  const request = (input.fetchImpl ?? fetch);
  const search = await request(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${slug.owner}/${slug.repo} "${input.candidate.fingerprint}" in:body`)}&per_page=10`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "agentrail-console" } }
  ).catch(() => null);
  if (search?.ok) {
    // Keep the response body available for a fetch seam that reuses one
    // Response object across calls (and for any caller that needs to inspect
    // the raw response after the dedupe probe). Production fetch returns a
    // fresh object, but cloning here makes the boundary deterministic.
    const data = (await search.clone().json().catch(() => null)) as { items?: Array<{ number?: unknown; html_url?: unknown; body?: unknown }> } | null;
    const existing = data?.items?.find((item) =>
      typeof item.number === "number" && typeof item.html_url === "string" && typeof item.body === "string" && item.body.includes(input.candidate.fingerprint)
    );
    if (existing && typeof existing.number === "number" && typeof existing.html_url === "string") {
      return { url: existing.html_url, number: existing.number, body: issueBody, repoFullName: `${slug.owner}/${slug.repo}` };
    }
  }
  let response: Response;
  try {
    response = await request(`https://api.github.com/repos/${slug.owner}/${slug.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agentrail-console",
      },
      body: JSON.stringify({
        title: proposal.title,
        body: issueBody,
        labels: [triggerLabel],
      }),
    });
  } catch {
    throw new Error("could not reach GitHub");
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`GitHub rejected the dependency-upgrade issue (HTTP ${response.status}): ${detail}`);
  }
  const created = (await response.json()) as { html_url?: unknown; number?: unknown };
  if (typeof created.html_url !== "string" || !Number.isInteger(created.number)) {
    throw new Error("GitHub returned an incomplete issue response");
  }
  return { url: created.html_url, number: created.number as number, body: issueBody, repoFullName: `${slug.owner}/${slug.repo}` };
}

export { parseGithubSlug };
