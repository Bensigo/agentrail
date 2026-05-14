# Bensigo AI Workflow

A project-local workflow kit for using AI coding agents with less guessing and more verified output.

It installs:

- `AGENTS.md` and `CONTEXT.md`
- agent docs under `docs/agents/`
- PRD and milestone folders under `docs/`
- project-local skills under `skills/`
- workflow scripts under `scripts/`

## Install

Install directly into the current project with `npx` from GitHub:

```bash
npx github:Bensigo/coding-ai-workflow --target .
```

Install into another project:

```bash
npx github:Bensigo/coding-ai-workflow --target /path/to/project
```

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
npx github:Bensigo/coding-ai-workflow --target /path/to/project --github-labels
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
docs/agents/
docs/prd/
docs/milestones/
```

Project-local skills:

```text
skills/bensigo-ai-workflow/
skills/grill-me/
skills/grill-with-docs/
skills/to-prd/
skills/to-milestones/
skills/to-issues/
skills/tdd/
skills/test-driven-development/
skills/mattpocock-skills/
```

Workflow scripts:

```text
scripts/afk-workflow
scripts/pr
scripts/ralph-loop
scripts/review-pr
```

## Recommended Flow

Use the full workflow for product features, risky changes, or work that needs agent handoff:

```text
grill-me / grill-with-docs
-> to-prd
-> to-milestones
-> to-issues
-> tdd / test-driven-development
-> ralph-loop
-> review-pr / pr
-> review-fix
```

For small edits, skip the heavy planning steps and implement directly with tests.

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
