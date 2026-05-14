---
name: to-milestones
description: Convert a PRD, product spec, plan, or feature brief into local markdown milestone files under `milestones/`, where each milestone is a vertical, testable software increment. Use before `to-issues` when the user wants a PRD converted to milestones and then issues, asks to create milestones, or wants work split into demoable product increments instead of horizontal phases like database first, backend first, frontend first.
---

# To Milestones

Turn a PRD into a small sequence of vertical milestones. Each milestone must produce a working, testable product outcome by taking the minimum useful slice across the layers it needs: data, domain logic, APIs, UI, jobs, integrations, tests, docs, and deploy/config.

Do not create horizontal milestones such as "database schema", "backend API", "frontend UI", or "auth setup". Those are implementation chores. A milestone is valid only if a user, tester, or stakeholder can verify a behavior after it lands.

## Workflow

### 1. Gather the PRD

Use the current conversation context if it contains the PRD. If the user passes a path, issue reference, or URL, fetch and read the full source.

If the PRD is missing core facts, ask only for blockers that change the milestone structure:

- target user and primary workflow
- first valuable outcome
- hard dependencies or compliance constraints
- required platform surfaces
- release deadline or sequencing constraint

### 2. Inspect the repo

Before drafting milestones, inspect enough of the repo to understand its current shape:

- existing `milestones/` directory and naming conventions
- `docs/agents/` setup docs, if present
- `CONTEXT.md`, `CONTEXT-MAP.md`, and `docs/adr/`, if present
- app surfaces, API boundaries, data/storage layer, test commands, and existing feature patterns

Use the project's domain vocabulary in milestone titles and acceptance criteria.

### 3. Draft vertical milestones

Draft milestones as ordered product increments.

Each milestone must:

- deliver one coherent user-visible or operator-visible outcome
- include the smallest necessary changes across all layers needed to make that outcome work
- be testable independently
- leave the product in a coherent state
- have clear acceptance criteria
- list likely issue slices that `to-issues` can create later

Reject horizontal slices:

- DB-only setup
- API-only setup
- UI-only shell
- auth plumbing without a usable protected behavior
- "create all models", "build all endpoints", "wire all pages"

Prefer:

- "User can create one draft project and see it persist after refresh"
- "Admin can approve one submitted request and the requester sees the status"
- "Import one CSV and preview validation errors before saving"

### 4. Quiz the user

Present the proposed milestones before writing files.

For each milestone, show:

- **Title**
- **Outcome**
- **Why this is first/next**
- **Testable proof**
- **Likely issue slices**
- **Blocked by**

Ask whether the sequence is right and whether any milestone is too broad to demo in one pass. Iterate until approved.

### 5. Write local markdown files

Create `milestones/` at the repo root if missing. Save one file per approved milestone:

```text
milestones/001-<slug>.md
milestones/002-<slug>.md
```

Use this template:

```markdown
# Milestone 001: <Title>

## Source PRD

<Path, issue, URL, or "conversation context">

## Outcome

<The product behavior this milestone makes real. No layer-by-layer implementation plan.>

## Users

- <Primary user or operator>

## Vertical Scope

This milestone may touch:

- UI:
- API/routes:
- Domain logic:
- Data/storage:
- Integrations/jobs:
- Tests:
- Docs/config:

Remove irrelevant bullets. Keep only layers needed for the outcome.

## Acceptance Criteria

- [ ] <Observable behavior>
- [ ] <Persistence/state/error case if relevant>
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

### 6. Hand off to `to-issues`

Tell the user which milestone file to feed into `to-issues` first. Usually start with `milestones/001-*.md`.

`to-issues` should create tracer-bullet issues from one milestone at a time, not from the whole PRD, unless the user explicitly asks for all milestones at once.
