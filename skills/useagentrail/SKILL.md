---
name: useagentrail
description: Use when shaping a substantial product or engineering idea into durable context, PRD, milestones, GitHub issues, implementation PRs, review, and follow-up fix issues. Trigger when the user asks to run AgentRail, convert an idea into implementation work, create PRD/milestones/issues, orchestrate Ralph, or manage review-fix loops. Do not use for tiny edits, one-off bug fixes, simple copy changes, or tasks that can be completed directly in one context.
---

# AgentRail Workflow

Run this workflow only when the work is large enough to benefit from staged thinking and agent handoffs. The goal is to keep agents in the smart zone: clear context, bounded tasks, concrete verification, and no open-ended autonomous wandering.

## Workflow

1. Grill the idea.
   - Challenge weak assumptions, missing users, unclear success criteria, and hidden constraints.
   - Do not proceed until the problem, target user, desired outcome, and non-goals are explicit.

2. Create durable context.
   - Capture domain facts, decisions, constraints, terminology, and unresolved questions in durable project docs.
   - Prefer repo-native context files, ADRs, and source-linked `docs/memory/` entries over chat-only memory.
   - Keep `CONTEXT.md` canonical; use `docs/memory/` for reusable lessons, preferences, and failure patterns that future agents should recall.
   - Use `TASTE.md` when product quality, UI standards, copy tone, interaction standards, or visual evidence expectations affect the work.

3. Write the PRD.
   - Convert the clarified idea into a focused PRD with goals, non-goals, user flows, requirements, acceptance criteria, risks, and verification expectations.
   - Keep it implementation-oriented. Avoid strategy prose that does not help an agent build.

4. Split into vertical milestones.
   - Break the PRD into thin, testable slices that each produce usable behavior.
   - Avoid horizontal milestones like "backend", "frontend", or "tests" unless the repo already uses that structure.

5. Create GitHub issues.
   - Turn each milestone into independently grabbable implementation issues.
   - Each issue must include context links, acceptance criteria, verification steps, and any visual evidence requirement.

6. Run the Ralph implementation loop.
   - Use the repo's Ralph runner to pick ready issues, implement, verify, and open or update PRs.
   - Recall relevant project memory before editing, then verify it against current code and docs.
   - Bound the run: choose one issue or a small fixed batch. Do not launch unbounded agent loops.

7. Require PR visual evidence.
   - Every implementation PR needs a visual evidence section.
   - For UI-visible work, include a screenshot or short video of the completed behavior.
   - For non-UI work, explicitly say there is no visual surface and include verification notes instead.
   - Check `TASTE.md` before judging product-quality or UI-visible work when that file exists.

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

## Guardrails

- Do not use this workflow for tiny changes. Direct implementation is cheaper and clearer.
- Keep each agent run bounded by a specific artifact or issue.
- Stop and ask when the idea lacks a real user, measurable outcome, or buildable scope.
- Prefer vertical slices over broad platform rewrites.
- Preserve existing edits by others. Own only the files or issues explicitly in scope.
- Treat project memory as advisory unless it is backed by current source links.
- Do not claim completion without verification evidence.
- Do not let agent loops run without a cap, checkpoint, or human-readable output.
