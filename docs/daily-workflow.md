# Daily workflow

Connect your coding agent from **Console → Agents**, then say “Use AgentRail to…” in the repository you want to work on. Clients that expose MCP prompts can use `agentrail_work`. The bundled `useagentrail` skill provides the same workflow. The connected agent drives the work. You can use AgentRail’s existing native runner for queued GitHub issues.

## Start where the work is

| Request | First action |
| --- | --- |
| “Help me shape this idea and ship the first slice” | Clarify the product decisions, write the PRD and vertical milestones in the repo, and link the GitHub issue for the selected slice. |
| “Fix the mobile invite screen” | Start from the issue or reproduce the behavior, then implement and check the change. |
| “Finish reviewing this PR” | Pick up the existing PR and check its latest head, feedback and CI. |

Open one task with `workflow_start` and keep its ID in the handoff. Set `delivery.kind` to `feature`, `fix`, or `pr`. Set `delivery.endpoint` to `review` by default or `release` when requested. Provide the user’s brief and, for a PR pickup, its URL. Use the intended working branch even if it has yet to be created. From **Work** you can copy a resume prompt to paste into another coding session. Read the task with `workflow_get` before resuming.

Use the existing `agentrail grill`, `agentrail prd`, `agentrail milestone`, and issue tooling when useful. GitHub and repository docs hold the work. Use the task checkpoints to link the result of each stage. Each update uses the current task revision and a stable event key for retries.

| Checkpoint | Record |
| --- | --- |
| `ready` | Testable acceptance criteria and, for a feature, the repo-relative Markdown plan path and a same-repository GitHub issue. A clear fix can start directly. |
| `review` | The reviewed PR head SHA. Attach the PR URL if it is new. Run the repository’s checks and capture product evidence before recording the head. |
| `rework` | Invalidate the recorded review and prepared release when another implementation pass is needed. Recheck the changed PR head. |
| `ship` | Continue an existing review task to release when the user asks to ship. |
| `release` | The merge commit observed on GitHub and the intended deployment URL after following the repository’s authorized merge and deploy procedure. |
| `follow_up` | Observations from a verified release and, when applicable, a linked GitHub issue in the same repository. |

Record a blocker with `workflow_update` when a material product choice or an unavailable prerequisite stops progress. Keep ordinary PR and CI feedback in the same task. Owner and admin decisions to close or reopen work still happen in the Console.

## Give a repository a repeatable verification path

Keep the steps to run, seed and exercise the product in the repo. Document the key routes or commands and what a user should observe. Reuse existing browser, CLI or API tests. Add regressions to the shared checks when a recurring failure is discovered. For UI work, capture evidence of the journey and identify device coverage accurately.

To enable release verification, add a trusted command to the target repo’s `.agentrail/config.json`. The example names a script the repo owns:

```json
{
  "workflow": {
    "checks": { "test": ["npm", "test"] },
    "release": { "verify": ["node", "scripts/verify-release.mjs"] }
  }
}
```

1. The verifier reads the deployed commit from the live application or deployment provider and runs a user-facing smoke check against that same deployment. The repo supplies its release URL and credentials through its own setup.
2. Exit nonzero when either check fails. After both pass, end stdout with one JSON line containing the **observed** values, for example `{"commitSha":"<40-character deployed commit>","url":"https://your-app.example/"}`. `AGENTRAIL_RELEASE_COMMIT` contains the expected SHA for comparison. Read the observed value independently of this variable. `AGENTRAIL_RELEASE_TARGET_URL` identifies the intended deployment. The observed URL must match it. Keep stdout free of secrets.
3. Create a release verifier key in **Console → Agents**. Keep `AGENTRAIL_WORKFLOW_RELEASE_API_KEY` in an operator or CI process with GitHub CLI access and the usual workflow key for reads. From that process, run `node packages/mcp/dist/verify-release.js TASK_ID REVISION EVENT_KEY [WORKTREE]` or call `workflow_verify_release` with the task ID, current revision and a stable event key. Use a clean checkout at the prepared merge commit, or pass the path of a registered Git worktree at that commit. The tool checks the PR’s reviewed head and merge SHA on GitHub, runs the verifier locally, and records its result. A failed check can be retried with a new event key after addressing the failure. An ambiguous execution hold stays visible until resolved.
4. **Work** shows the commit and observed URL when the configured check passes. This receipt comes from the separate verifier credential and its trusted repo command. The tool does not change branch protection, perform the merge or deploy, or grant access to production. Use the project’s existing release procedure under the user’s authorization.

The release verifier has 110 seconds to complete its checks. Use HTTPS URLs without credentials, query strings or fragments. Loopback HTTP is supported for local verification. Review changes to release commands as part of the repository’s normal review policy.
