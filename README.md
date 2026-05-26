# AgentRail

AgentRail is a repo-native harness for AI coding agents. It gives agents durable context, workflow state, bounded issue execution, review loops, and verification gates so agent work is easier to inspect, resume, and trust.

It installs:

- `AGENTS.md` and `CONTEXT.md`
- optional product quality guidance in `TASTE.md`
- agent docs under `docs/agents/`
- project memory under `docs/memory/`
- PRD and milestone folders under `docs/`
- project-local skills under `skills/`
- workflow scripts under `scripts/`
- durable AgentRail state under `.agentrail/state.json`

## Install

Install directly into the current project with `npx` from GitHub:

```bash
npx --package github:Bensigo/agentrail agentrail init --target .
```

Install into another project:

```bash
npx --package github:Bensigo/agentrail agentrail init --target /path/to/project
```

The CLI command is `agentrail`.

From a local checkout of this repo:

```bash
scripts/install-workflow --target /path/to/project
```

Overwrite existing installed files:

```bash
scripts/install-workflow --target /path/to/project --force
```

Create or update the expected GitHub labels too:

```bash
npx --package github:Bensigo/agentrail agentrail init --target /path/to/project --github-labels
```

After install, go to the target project:

```bash
cd /path/to/project
```

Then edit `CONTEXT.md`. Do this before asking agents to plan or implement non-trivial work.

## What Gets Installed

Project docs:

```text
AGENTS.md
CONTEXT.md
TASTE.md
docs/agents/
docs/memory/
docs/prd/
docs/milestones/
```

Project-local skills:

```text
skills/bensigo-ai-workflow/
skills/grill-with-docs/
skills/to-prd/
skills/to-milestones/
skills/to-issues/
skills/tdd/
```

Workflow scripts:

```text
scripts/agentrail
scripts/afk-workflow
scripts/memory
scripts/pr
scripts/ralph-loop
scripts/review-pr
```

Durable project state:

```text
.agentrail/state.json
```

The state file records the AgentRail version, install timestamps, managed file inventory, file hashes, and the current workflow pointer. Its format is documented in `docs/agents/agentrail-state.md`.

Check an installed or partially installed project:

```bash
scripts/agentrail doctor --target /path/to/project
```

`agentrail doctor` reports missing core files, optional `TASTE.md`, state health, managed file hash drift, and GitHub label gaps when `gh` is available in a connected GitHub repo. Missing recommendations are warnings; invalid usage and corrupt state fail non-zero.

Upgrade managed AgentRail files without overwriting local edits:

```bash
scripts/agentrail upgrade --target /path/to/project
```

Use `--force` only after reviewing reported local modifications.

## Recommended Flow

Use the full workflow for product features, risky changes, or work that needs agent handoff:

```text
grill-with-docs
-> to-prd
-> to-milestones
-> to-issues
-> tdd
-> ralph-loop
-> review-pr / pr
-> review-fix
```

For small edits, skip the heavy planning steps and implement directly with tests.

## How To Use It With An Agent

Start with `CONTEXT.md`. Keep the product, domain language, constraints, and repo-specific decisions there. The workflow works poorly if `CONTEXT.md` is empty or stale.

Customize `TASTE.md` when the project has product quality expectations that should guide agents: UI standards, copy tone, interaction preferences, visual evidence expectations, and anti-patterns. If the project is backend-only or has no useful taste guidance yet, missing `TASTE.md` is only a recommendation, not a blocker.

Use `docs/memory/` for source-linked lessons, preferences, and recurring failure patterns that should survive across agent runs. Memory is advisory; agents still need to verify it against current code and canonical docs.

Recall project memory before non-trivial work:

```bash
scripts/memory recall "<feature, issue, PR, or keyword>"
```

When you want to work on a new feature, ask the agent to grill the idea first:

```text
Use grill-with-docs. I want to build <feature idea>. Challenge the idea against this repo's CONTEXT.md and codebase before we write a PRD.
```

Use `grill-with-docs` when:

- the feature is vague
- the user, outcome, or non-goals are unclear
- the change touches important domain behavior
- you are not sure what should be built first

After the idea is clear, turn it into a PRD:

```text
Use to-prd. Turn the clarified feature into a PRD under docs/prd/.
```

Then split the PRD into vertical milestones:

```text
Use to-milestones on docs/prd/<file>. Create testable vertical milestones.
```

Then create implementation issues from one milestone at a time:

```text
Use to-issues on docs/milestones/001-<file>. Create independently grabbable GitHub issues with acceptance criteria and verification steps.
```

When implementing an issue, use TDD:

```text
Use tdd. Implement issue #123 with a red-green-refactor loop. Do not write production code before a failing test.
```

For one bounded implementation run:

```bash
scripts/ralph-loop --issue 123 --print-prompt
```

For unattended batches of approved work:

```bash
scripts/afk-workflow run --concurrency 2 --max-waves 5
```

Review PRs before merge:

```bash
scripts/review-pr --pr 123
```

Use the full flow for meaningful product work. For tiny fixes, ask for a direct TDD implementation instead of creating PRDs and milestones.

## Common Commands

Print a Ralph implementation prompt for one issue:

```bash
scripts/ralph-loop --issue 123 --print-prompt
```

Run Ralph through an agent command:

```bash
RALPH_AGENT_COMMAND='codex exec -' scripts/ralph-loop --issue 123
```

Run the AFK issue workflow:

```bash
scripts/afk-workflow run --concurrency 2 --max-waves 5
```

Inspect an AgentRail install:

```bash
scripts/agentrail doctor --target .
```

Upgrade an AgentRail install:

```bash
scripts/agentrail upgrade --target .
```

Review one PR:

```bash
scripts/review-pr --pr 123
```

Use the PR helper:

```bash
scripts/pr review-init 123
scripts/pr review-checkout-pr 123
scripts/pr review-validate-artifacts 123
```

## Requirements

The scripts expect the target project to be a git repo. Depending on the command, they may also require:

- `gh`
- `jq`
- `rg`
- `codex`
- `pnpm`
- `node`

Run:

```bash
npm test
```

from this workflow repo to verify the installer.
