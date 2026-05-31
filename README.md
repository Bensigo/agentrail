# AgentRail

AgentRail is a repo-native harness for AI coding agents. It gives agents durable context, workflow state, bounded issue execution, review loops, and verification gates so agent work is easier to inspect, resume, and trust.

It installs:

- `AGENTS.md` and `CONTEXT.md`
- optional product quality guidance in `TASTE.md`
- agent docs under `docs/agents/`
- project memory under `docs/memory/`
- PRD and milestone folders under `docs/`
- project-local skills under `skills/`
- durable AgentRail state under `.agentrail/state.json`
- AgentRail config under `.agentrail/config.json`

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

Immediate GitHub package path: `npx github:Bensigo/agentrail`.

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

Sync labels later without reinstalling AgentRail:

```bash
agentrail labels sync --target /path/to/project
```

Run label sync after connecting a repository to GitHub, after adding a new AgentRail workflow label, or when `agentrail doctor` reports missing GitHub labels.

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
skills/backend-api/
skills/desktop-tauri/
skills/devops-deploy/
skills/docs-current/
skills/frontend-web/
skills/grill-with-docs/
skills/to-prd/
skills/to-milestones/
skills/to-issues/
skills/tdd/
```

AgentRail ships curated first-party skills, not arbitrary third-party hot installs. Upstream projects may be listed in `docs/agents/skill-registry.json` as provenance candidates, but those references are audit notes, not trusted install sources. The installed `skills/` files are the reviewed local copies that prompts point agents to read.

Internal compatibility copy:

```text
.agentrail/source/
```

Installed projects should use the `agentrail` CLI. Raw Ralph, AFK, review, PR, and memory scripts are package internals and are kept under `.agentrail/source/` only for compatibility and upgrades.

Durable project state:

```text
.agentrail/state.json
.agentrail/config.json
```

The state file records the AgentRail version, install timestamps, managed file inventory, file hashes, and the current workflow pointer. Its format is documented in `docs/agents/agentrail-state.md`.

The config file stores the single active project runner. New installs default to Codex:

```json
{
  "schemaVersion": 1,
  "runner": {
    "name": "codex",
    "command": "codex exec -"
  }
}
```

Built-in runner names are `codex`, `claude`, `cursor`, and `hermes`. Use `custom` with a command string for unsupported tools. The configured runner is used by `agentrail run` unless you pass an explicit command for a local test or one-off execution.

Check an installed or partially installed project:

```bash
agentrail doctor --target /path/to/project
```

`agentrail doctor` reports missing core files, optional `TASTE.md`, state health, managed file hash drift, old script-first installs, and GitHub label gaps when `gh` is available in a connected GitHub repo. Missing recommendations are warnings; invalid usage and corrupt state fail non-zero.

It also validates the managed skill registry for installed targets. Missing registry files are reported under `core:`; invalid registry data or broken `localPath` entries are reported under `skills:` and make `doctor` fail.

Upgrade managed AgentRail files without overwriting local edits:

```bash
agentrail upgrade --target /path/to/project
```

Use `--force` only after reviewing reported local modifications.

## Curated Skills

Inspect the bundled skills in an installed project:

```bash
agentrail skills list --target .
```

Preview the resolver for a task before generating or running a prompt:

```bash
agentrail skills resolve "fix Tauri desktop UI" --target .
```

The resolver combines task keywords, installed project files, and package signals. Output includes each selected skill, its local `SKILL.md` path, and the reason it matched.

Force a skill when the resolver misses useful context:

```bash
agentrail prompt issue 123 --skill frontend-web --target .
```

Disable automatic skill matching when a task should stay narrow:

```bash
agentrail prompt issue 123 --no-auto-skills --target .
```

Use both flags to include only explicit skills:

```bash
agentrail prompt issue 123 --skill frontend-web --no-auto-skills --target .
```

Maintainers should treat upstream skill material as supply-chain input: borrow aggressively, vendor carefully, update intentionally, never auto-trust. Before changing `docs/agents/skill-registry.json`, verify the upstream source still exists, record the current URL or observed commit/SHA when available, check the license and audit status, then update the local skill file and tests in the same PR.

## Recommended Flow

Use the full workflow for product features, risky changes, or work that needs agent handoff:

```text
grill-with-docs
-> to-prd
-> to-milestones
-> to-issues
-> tdd
-> agentrail run issue
-> agentrail prompt review
-> review-fix
```

For small edits, skip the heavy planning steps and implement directly with tests.

## Run Work

Use the state-first runner when you want AgentRail to decide what needs attention:

```bash
agentrail run
```

It reads `.agentrail/state.json` first. If an active run exists, it prints the issue, run directory, prompt, metadata, and next action instead of starting new work. If no active run exists, it selects the next open GitHub issue labeled `afk` and `ready-for-agent`, excluding issues already labeled `afk-in-progress`.

Run a specific issue when you already know the target:

```bash
agentrail run issue 123
```

The explicit issue path still checks durable state first and refuses to start conflicting active work.

Issue runs execute one plan phase, then repeat execute and verify until verification passes. When verify fails, AgentRail writes structured findings under the verify attempt directory and passes them into the next execute attempt. The default limit is 5 execution attempts; after that the run is marked blocked with the latest findings and next action in `.agentrail/state.json`.

## How To Use It With An Agent

Start with `CONTEXT.md`. Keep the product, domain language, constraints, and repo-specific decisions there. The workflow works poorly if `CONTEXT.md` is empty or stale.

Customize `TASTE.md` when the project has product quality expectations that should guide agents: UI standards, copy tone, interaction preferences, visual evidence expectations, and anti-patterns. If the project is backend-only or has no useful taste guidance yet, missing `TASTE.md` is only a recommendation, not a blocker.

Use `docs/memory/` for source-linked lessons, preferences, and recurring failure patterns that should survive across agent runs. Memory is advisory; agents still need to verify it against current code and canonical docs.

Recall project memory before non-trivial work in an installed project:

```bash
scripts/agentrail memory recall "<feature, issue, PR, or keyword>"
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
agentrail run issue 123
```

For unattended batches of approved work:

```bash
agentrail run
```

`agentrail run` reads `.agentrail/state.json` before selecting queued issues. If an active AgentRail run exists, it stops and reports the run metadata. If no active run exists, it selects the next open GitHub issue labeled `afk` and `ready-for-agent`, excluding `afk-in-progress`.

## Dogfooding AgentRail

Maintainers can run the AFK workflow from this AgentRail source repo without installing generated project templates over the source checkout. Use the template runner directly:

```bash
templates/scripts/afk-workflow run --concurrency 1 --max-waves 1 --dry-run
```

For a bounded real wave, keep the run small:

```bash
templates/scripts/afk-workflow run --concurrency 1 --max-waves 1
```

The source repo does not need root-level `scripts/ralph-loop`, `scripts/review-pr`, or `scripts/memory` files. The AFK runner resolves those helpers from `templates/scripts/` when the installed `scripts/` copies are not present. That keeps source-repo self-hosting separate from installing AgentRail into a target project.

AFK dogfooding still requires `.agentrail/state.json` in the repo where the runner starts. Use `agentrail install --target .` when state has not been initialized.

Review PRs before merge:

```bash
agentrail prompt review 123
```

Use the full flow for meaningful product work. For tiny fixes, ask for a direct TDD implementation instead of creating PRDs and milestones.

## Codex Desktop Workflow

AgentRail does not replace Codex Desktop or Claude Code. Codex or Claude remains the worker. AgentRail provides the rails around that worker: repo-owned state, prompt generation, checks, GitHub labels, review loops, and verification gates.

In a Codex Desktop project session, start by checking durable state:

```bash
agentrail status --target .
agentrail resume --target .
```

Use `status` to inspect the installed AgentRail state, current workflow pointer, active run, and recent completed runs. Use `resume` after chat compaction, a new session, or an interrupted run. The resume output tells Codex Desktop to recover from `.agentrail/state.json`, source files, docs, run metadata, and GitHub state instead of trusting previous chat context.

Generate prompts when you want to inspect or hand off the next step before executing it:

```bash
agentrail prompt grill "Build <feature idea>" --agent codex --target .
agentrail prompt issue 123 --agent codex --target .
agentrail prompt review 456 --agent codex --target .
```

Run a bounded worker command when the prompt is already clear:

```bash
agentrail run issue 123 --agent codex --target .
```

AgentRail routes Codex prompts toward repo-local skills and docs. For example, a grill prompt points Codex at `grill-with-docs`; an issue prompt points it at AgentRail issue execution, which invokes Ralph internally during the execute phase; a review prompt points it at PR review instructions. Claude prompts use the same AgentRail intent but refer to local instruction files instead of Codex-specific skill mechanics.

The main context files fit together like this:

- `AGENTS.md`: operating rules agents should follow in this repo.
- `CONTEXT.md`: product, domain, architecture, and repository facts.
- `TASTE.md`: optional product quality, UI, copy, interaction, and visual evidence guidance.
- `docs/memory/`: source-linked lessons, decisions, preferences, and failure patterns to recall before non-trivial work.
- GitHub issues: implementation source of truth, acceptance criteria, blockers, and AFK eligibility.
- `.agentrail/state.json`: durable workflow pointer for compaction recovery, handoffs, active issue/PR state, active run state, retry attempts, recent completed/failed runs, and next suggested action.

AgentRail is local CLI workflow infrastructure, not a hosted orchestration platform. Keep runs bounded, review PRs before merge, and verify changes with the commands recorded in each PR.

## Common Commands

Run one issue through AgentRail:

```bash
agentrail run issue 123
```

Recall project memory:

```bash
agentrail memory recall "issue 123"
```

Inspect an AgentRail install:

```bash
agentrail doctor --target .
```

Upgrade an AgentRail install:

```bash
agentrail upgrade --target .
```

Generate a PR review prompt:

```bash
agentrail prompt review 123
```

## Migration From Script-First Installs

Older AgentRail installs placed raw workflow helpers under `scripts/`. New installs keep those helpers out of the normal project surface and route agents through the local `scripts/agentrail` CLI shim.

Use these replacements:

```text
scripts/memory recall ...        -> scripts/agentrail memory recall ...
scripts/ralph-loop --issue 123   -> scripts/agentrail run issue 123
scripts/afk-workflow run ...     -> scripts/agentrail run
scripts/review-pr --pr 123       -> scripts/agentrail prompt review 123
scripts/agentrail doctor ...     -> scripts/agentrail doctor ...
scripts/agentrail upgrade ...    -> scripts/agentrail upgrade ...
```

`scripts/agentrail doctor` reports legacy raw workflow scripts when it finds them. After checking for local edits, remove the old `scripts/memory`, `scripts/ralph-loop`, `scripts/afk-workflow`, `scripts/review-pr`, and `scripts/pr` files from installed projects. Keep `scripts/agentrail`; it is the supported local CLI entrypoint.

Maintainers debugging AgentRail itself can still use the internal helpers from a source checkout:

```bash
templates/scripts/afk-workflow run --concurrency 1 --max-waves 1 --dry-run
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
