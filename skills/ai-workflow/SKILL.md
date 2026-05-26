---
name: ai-workflow
description: Use when shaping a substantial product or engineering idea into durable context, PRD, milestones, GitHub issues, implementation PRs, review, and follow-up fix issues. Trigger when the user asks to run the AI workflow, convert an idea into implementation work, create PRD/milestones/issues, orchestrate Ralph, or manage review-fix loops. Do not use for tiny edits, one-off bug fixes, simple copy changes, or tasks that can be completed directly in one context.
---

# AI Workflow

Run this workflow only when the work is large enough to benefit from staged thinking and agent handoffs. The goal is to keep agents in the smart zone: clear context, bounded tasks, concrete verification, and no open-ended autonomous wandering.

## Workflow

1. Grill the idea.
   - Challenge weak assumptions, missing users, unclear success criteria, and hidden constraints.
   - Do not proceed until the problem, target user, desired outcome, and non-goals are explicit.

2. Create durable context.
   - Capture domain facts, decisions, constraints, terminology, and unresolved questions in durable project docs.
   - Prefer repo-native context files, ADRs, and source-linked `docs/memory/` entries over chat-only memory.
   - Keep `CONTEXT.md` canonical; use `docs/memory/` for reusable lessons, preferences, and failure patterns that future agents should recall.

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

8. Review the PR.
   - Run review in a fresh context using the repo's review runner when available.
   - Prioritize correctness, regressions, missing tests, unclear verification, and mismatch with the issue or PRD.
   - Classify serious findings to decide whether they reveal a reusable failure pattern, project preference violation, missing context, or unclear acceptance criteria.

9. Convert review findings.
   - P0 findings create new GitHub issues immediately.
   - Non-P0 findings become PR review comments.
   - Reusable failure patterns become memory suggestion issues, not silent memory edits.
   - Do not bury severe follow-up work in a comment thread.

10. Run the review-fix follow-up.
    - Create or pick the review-fix issue, implement the fix, verify it, and update the PR.
    - Repeat review only as far as needed to resolve the specific findings.

## One-Issue Ralph Loop

Use this when the user wants Ralph to implement exactly one ready issue.

Inputs:
- One GitHub issue URL or issue number.
- Repo path, target branch, and any required context links.
- Verification command or acceptance checklist from the issue.

Steps:
1. Read the issue, linked PRD/milestone/context, and relevant project memory.
2. Confirm the issue is buildable, scoped to one vertical slice, and has acceptance criteria.
3. Start a bounded Ralph run for that issue only.
4. Implement the smallest complete change that satisfies the issue.
5. Run the issue's verification steps and any directly relevant tests.
6. Open or update the PR with implementation notes and required visual evidence.

Outputs:
- Updated branch and PR.
- Verification results.
- Visual evidence, or an explicit non-UI verification note.

Guardrails:
- Do not batch unrelated issues into this loop.
- Stop if the issue is ambiguous, blocked, or lacks acceptance criteria.
- Do not let Ralph continue past the named issue without a new instruction.

## PR Review Loop

Use this when a PR needs an independent review pass.

Inputs:
- PR URL or number.
- Source issue, PRD, milestone, and verification expectations.
- Review scope, including any files or risks to focus on.

Steps:
1. Read the PR, diff, linked issue, and relevant context in a fresh context.
2. Review the PR by running a bounded `github-pr-reviewer` pass during "Review the PR".
3. Check correctness, regressions, missing tests, unclear verification, and mismatch with the issue or PRD.
4. Separate findings by severity.
5. Post actionable review comments for non-P0 findings.
6. Create immediate GitHub issues for P0 findings.

Outputs:
- PR review comments or approval notes.
- New P0 issue links when applicable.
- Memory suggestion issue links when review identifies a reusable pattern.
- Review summary with verification gaps and residual risks.

Guardrails:
- Keep `github-pr-reviewer` bounded to the named PR and review scope.
- Do not rewrite or fix code during this loop.
- Do not convert speculative preferences into findings.
- Do not edit project memory directly from review. Propose a source-linked memory suggestion issue instead.

## Review-Fix Loop

Use this when review findings need to become implementation work.

Inputs:
- Review findings, comments, or P0 issue links.
- Original PR, source issue, and expected verification.
- Fix scope and severity cutoff.

Steps:
1. Turn each accepted finding into a fix issue unless it is small enough to fix directly in the current PR.
2. Group related findings only when they share the same cause and verification path.
3. Pick one fix issue or a small fixed batch for a bounded follow-up run.
4. Implement the fix, preserving unrelated edits.
5. Run targeted verification plus any regression tests tied to the original issue.
6. Update the PR with fix notes, verification results, and revised visual evidence when UI-visible.
7. Run a bounded follow-up review only for the fixed findings.

Outputs:
- Fix issue links or direct PR update notes.
- Updated PR with verification evidence.
- Follow-up review result for the fixed findings.

Guardrails:
- Do not reopen product scope during review-fix work.
- Do not mix unrelated cleanup with review fixes.
- Stop if a finding requires product clarification or changes the original acceptance criteria.

## Guardrails

- Do not use this workflow for tiny changes. Direct implementation is cheaper and clearer.
- Keep each agent run bounded by a specific artifact or issue.
- Stop and ask when the idea lacks a real user, measurable outcome, or buildable scope.
- Prefer vertical slices over broad platform rewrites.
- Preserve existing edits by others. Own only the files or issues explicitly in scope.
- Treat project memory as advisory unless it is backed by current source links.
- Do not claim completion without verification evidence.
- Do not let agent loops run without a cap, checkpoint, or human-readable output.
