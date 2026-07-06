---
name: to-milestones
description: Turn a PRD into a short sequence of vertical milestone markdown files under `docs/milestones/`, each a demoable product increment. Read-only drafting — writes local milestone files only, creates no issues and needs no approval while drafting.
---

# To milestones

Turn a PRD into a small ordered sequence of vertical milestones, one markdown
file each under `docs/milestones/`. This sits between `to-prd` and `to-issues`
in the pipeline: it is READ-ONLY drafting that writes local milestone files and
nothing else. It crosses no factory boundary — only `create_issue` (in
`to-issues`) does — so never call `create_issue` from this skill.

Each milestone is a vertical increment: it delivers one coherent, verifiable
product outcome by taking the minimum useful slice across every layer that
outcome needs — data, domain logic, APIs, UI, jobs, integrations, tests, config.

## Reject horizontal milestones

A milestone is valid only if a user, tester, or operator can verify a behavior
once it lands. Refuse implementation-chore milestones — they are horizontal
slices wearing a milestone label:

- "database schema", "backend API", "frontend UI shell", "auth setup"
- "create all models", "build all endpoints", "wire all pages"
- auth plumbing with no usable protected behavior behind it

Draft the vertical shape instead:

- "User can create one draft project and see it persist after refresh"
- "Admin can approve one submitted request and the requester sees the status"
- "Import one CSV and preview validation errors before saving"

## Workflow

1. **Take the PRD.** Work from the PRD in the conversation, or fetch it if the
   human passes a path or URL. If a structural fact is missing — target user and
   primary workflow, the first valuable outcome, a hard dependency or compliance
   constraint, a required platform surface, or a sequencing deadline — ask only
   for the blockers that change the milestone structure. Respect the CONTEXT.md /
   TASTE.md decisions the PRD names; if a source conflicts with them, surface the
   conflict before drafting rather than silently choosing one.
2. **Draft vertical milestones.** Order them as product increments. Each one
   delivers a single user- or operator-visible outcome, includes the smallest
   changes across every layer that outcome needs, is testable on its own, leaves
   the product coherent, and lists the likely issue slices `to-issues` will cut
   from it later.
3. **Quiz the human.** Present the proposed milestones before writing any file.
   For each, show the Title, the Outcome, why it is first/next, its testable
   proof, its likely issue slices, and what it is blocked by. Ask whether the
   sequence is right and whether any milestone is too broad to demo in one pass.
   Iterate until approved.
4. **Write the files.** Create `docs/milestones/` at the repo root if missing,
   then save one file per approved milestone (`001-<slug>.md`, `002-<slug>.md`, …)
   using the template below.
5. **Hand off one at a time.** Tell the human which milestone file to feed into
   `to-issues` first — usually `001`. `to-issues` cuts tracer-bullet issues from
   one milestone at a time, not from the whole PRD, unless the human asks for all
   milestones at once.

## Milestone file template

```markdown
# Milestone 001: <Title>

## Source PRD

<Path, issue, URL, or "conversation context">

## Required Context

- `CONTEXT.md`: <Constraints, domain facts, terminology, or requirements this milestone must respect>
- `TASTE.md`: <Product quality, UI, copy, interaction, or visual-evidence requirements; write "Not present" only if the file does not exist>

## Outcome

<The product behavior this milestone makes real. Not a layer-by-layer plan.>

## Users

- <Primary user or operator>

## Vertical Scope

This milestone may touch — keep only the layers the outcome needs:

- UI:
- API/routes:
- Domain logic:
- Data/storage:
- Integrations/jobs:
- Tests:
- Docs/config:

## Acceptance Criteria

- [ ] <Observable behavior>
- [ ] <Persistence, state, or error case if relevant>
- [ ] <Test or verification evidence>

## Test Plan

- <Automated test command or test type>
- <Manual verification path if needed>

## Likely Issue Slices

- <Thin issue slice for to-issues>
- <Thin issue slice for to-issues>

## Blocked By

None.

## Notes

<Decisions, risks, or open questions. Omit if empty.>
```
