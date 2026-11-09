# AgentRail / Jace repository separation

Approved 2026-11-09 by the owner in the implementation chat.

## Outcome
AgentRail is the independent development workflow and Console for any MCP-compatible coding agent. Jace is the independent acceptance/evidence trust layer at Bensigo/jace. Neither product requires the other to start. Each owns its database, credentials, deployment and release lifecycle.

## Ownership
- AgentRail: Python workflow/CLI/context/skills/runner, repository-context MCP, agent-led task/run reporting, workflow Console, objective checks and independent-review machinery.
- Jace: conversation/channels, Acceptance Records and Contracts, exact-head criterion evidence, corrections, human decisions, trust Console and trust MCP.
- Initially copied infrastructure: auth, database adapters, GitHub client, UI and context/compiler compatibility code. Internal historical @agentrail names are not a runtime dependency on the other repository.
- Retain inherited SQL history and legacy database compatibility helpers. Do not delete customer data or rewrite shared history. New product migrations diverge after the pinned split commit.

## Milestones and acceptance
1. Preserve full Git history in both repositories. Establish independent setup, CI and release boundaries.
2. AgentRail exposes generic MCP context and workflow tools. No Jace tools or Jace service are required. Task writes are bounded, tenant-scoped, retry-safe and revision-checked. The Console reads the same records. Agent-reported completion/checks never become Jace criterion proof.
3. Restore AgentRail workflow navigation and readable task detail, preserve existing native workflow routes, supply direct owner controls and MCP credential setup.
4. Verify real MCP protocol list/start/update/read against a local Console and real database, restart persistence, cross-workspace refusal, stale-revision refusal, and terminal-state behavior. Exercise at least two differently named agent identities; this proves protocol portability, not real third-party-client acceptance.
5. Build Jace independently and preserve its existing acceptance authority. Publish both source branches/repositories only with accurate source/runtime proof. Both projects must run fully locally. Vercel is the future hosting target; Railway migration is cancelled. No production database, DNS, secret, billing or live deployment cutover is included.

## Verification boundary
Distinguish unit/source tests, local integrated runtime, CI, deployed/live, and customer proof. A successful build is not a live migration. Existing open PRs stay in the original repository and need explicit ownership/routing; do not merge the superseded #1638 draft.

## Owner clarification: full local operation and open source
Both repositories are public Apache-2.0 projects. Local Console/API/data/required workers run without hosted AgentRail/Jace signup. `compose.local-data.yml` isolates data networks, volumes and loopback ports; application processes run on the host. `pnpm local:up` builds shared packages and starts the local stack; `pnpm local:open` issues a two-minute single-use operator login. This route is default-off outside the local profile and disabled on Vercel. GitHub/model/channel credentials are optional integration configuration, not hosted-product accounts. Local inference uses the configurable Ollama-compatible path. Vercel deployment is subsequent work, not a prerequisite for local use.

## Open work at the split
Trust-layer PRs #1739, #1737, #1736 and #1576 remain in the original repository and need a deliberate port to Jace before integration. Their branches/history were preserved; they were not silently merged into this split. Draft #1638 is superseded by the owner's two-product decision. See [local verification](local-verification-2026-11-09.md) for observed results and limits.
