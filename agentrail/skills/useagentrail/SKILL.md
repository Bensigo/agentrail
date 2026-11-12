---
name: useagentrail
description: Use when the user asks AgentRail to carry an idea, fix, GitHub issue or pull request through implementation, review, release verification or follow-up.
---

# AgentRail Workflow

Use one AgentRail task from the request to the user’s requested endpoint. When available, load the `agentrail_work` MCP prompt with the request. Otherwise use the following workflow.

## Entry points

- Resume an existing task with `workflow_get`. Look for it before opening a duplicate.
- Start new work with `workflow_start` and the `delivery` fields. A feature begins with shaping. A clear fix goes straight to implementation. An existing PR starts with its URL at review. Choose review as the endpoint unless the user requests release.
- Only use the planning steps below for work that needs them. Link a shaped feature's plan, selected GitHub issue, and testable criteria with the `ready` checkpoint.

## Workflow

1. Grill the idea.
   - Challenge weak assumptions, missing users, unclear success criteria, and hidden constraints.
   - Do not proceed until the problem, target user, desired outcome, and non-goals are explicit.

2. Create durable context.
   - Capture domain facts, decisions, constraints, terminology, and unresolved questions in durable project docs.
   - Prefer repo-native context files, ADRs, and source-linked `.agentrail/memory/` entries (legacy: `docs/memory/`) over chat-only memory.
   - Keep `.agentrail/context.md` (legacy: `CONTEXT.md`) canonical; use `.agentrail/memory/` for reusable lessons, preferences, and failure patterns that future agents should recall.
   - Use `.agentrail/taste.md` (legacy: `TASTE.md`) when product quality, UI standards, copy tone, interaction standards, or visual evidence expectations affect the work.

3. Write the PRD.
   - Convert the clarified idea into a focused PRD with goals, non-goals, user flows, requirements, acceptance criteria, risks, and verification expectations.
   - Keep it implementation-oriented. Avoid strategy prose that does not help an agent build.

4. Split into vertical milestones.
   - Break the PRD into thin, testable slices that each produce usable behavior.
   - Avoid horizontal milestones like "backend", "frontend", or "tests" unless the repo already uses that structure.

5. Create GitHub issues.
   - Turn each milestone into independently grabbable implementation issues.
   - Each issue must include context links, acceptance criteria, verification steps, and any visual evidence requirement.

6. Execute through the selected workflow.
   - Stay in the connected coding agent for interactive work. For an authorized queued run, use the existing bounded Ralph runner on the selected ready issue.
   - Reuse the project's context, commands, and user-facing verification harness. Run named checks through `workflow_check` where configured.
   - Carry the same task ID through review and later sessions. Record progress and specific blockers with `workflow_update`.

7. Require PR visual evidence.
   - Every implementation PR needs a visual evidence section.
   - For UI-visible work, include a screenshot or short video of the completed behavior.
   - For non-UI work, explicitly say there is no visual surface and include verification notes instead.
   - Check `.agentrail/taste.md` (legacy: `TASTE.md`) before judging product-quality or UI-visible work when that file exists.

8. Review the PR.
   - Run review in a fresh context using the repo's review runner when available.
   - Prioritize correctness, regressions, missing tests, unclear verification, and mismatch with the issue or PRD.

9. Convert review findings.
   - P0 findings create new GitHub issues immediately.
   - Non-P0 findings become PR review comments.
   - Do not bury severe follow-up work in a comment thread.

10. Run the review-fix follow-up.
    - Create or pick the review-fix issue, implement the fix, verify it, and update the PR.
    - Repeat review only as far as needed to resolve the specific findings.

11. Follow the requested endpoint.
    - After reviewing the current PR head, record the `review` checkpoint with the SHA and PR URL. Use `rework` when another implementation pass is needed. Continue routine feedback and CI work within the run's scope.
    - When the user extends a review task to release, use `ship`. Follow the project's authorized merge and deploy procedure. Record the observed GitHub merge SHA with the `release` checkpoint.
    - Call `workflow_verify_release` from a clean checkout of that SHA. Its configured verifier must check the deployed version and smoke-test the live behavior. Resolve failures or report the specific blocker.
    - Use `follow_up` to record observations or link follow-up issues after a verified release. Turn recurring corrections into project checks or clearer code boundaries.

## Guardrails

- Keep small changes direct. Reserve the full planning flow for features that need it.
- Keep each agent run bounded by a specific artifact or issue.
- Stop and ask when the idea lacks a real user, measurable outcome, or buildable scope.
- Prefer vertical slices over broad platform rewrites.
- Preserve existing edits by others. Own only the files or issues explicitly in scope.
- Treat project memory as advisory unless it is backed by current source links.
- Do not claim completion without verification evidence.
- Do not let agent loops run without a cap, checkpoint, or human-readable output.
