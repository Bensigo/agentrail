# AgentRail State

AgentRail stores repo-local project state in `.agentrail/state.json`.

AgentRail is the harness around coding agents. The configured runner in `.agentrail/config.json` is the worker that receives generated prompts. Ralph is AgentRail's internal one-issue executor for bounded implementation. AFK is the queue/worktree loop for unattended batches of eligible issues.

This file is intended for manual inspection by agents and maintainers. It records installation metadata, the files AgentRail manages, and the current workflow pointer so work can resume without relying on chat memory.

AgentRail stores project runner configuration in `.agentrail/config.json`. The config is separate from state because it is a local execution preference, not workflow progress.

AgentRail also installs `.agentrail/agents/skill-registry.json`. The registry is a managed artifact that describes bundled skills, their local `SKILL.md` paths, activation triggers, provenance candidates, license status, audit status, and default bundling behavior.

## Top-Level Fields

- `schemaVersion`: state file format version.
- `agentrailVersion`: AgentRail package version that last wrote the file.
- `installedAt`: ISO timestamp for the first AgentRail install or adoption.
- `updatedAt`: ISO timestamp for the most recent installer update.
- `legacyAdopted`: `true` when the installer found existing AgentRail-managed files before any state file existed.
- `managedFiles`: inventory of files AgentRail owns or has adopted.
- `workflow`: current workflow progress pointer.

## Managed Files

Each `managedFiles` entry has:

- `path`: repo-relative installed path.
- `source`: AgentRail package source path.
- `contentHash`: SHA-256 hash of the installed file, prefixed with `sha256:`.
- `installStatus`: one of `installed`, `preserved`, `updated`, or `legacy-adopted`.

The installer preserves local edits unless run with `--force`. When a project already has AgentRail files but no `.agentrail/state.json`, the installer treats those files as an adoptable legacy install and records their current hashes instead of failing.

## Workflow

`workflow` can represent:

- `phase`
- `activePhase`
- `activeIssue`
- `activePullRequest`
- `activePrd`
- `activeMilestone`
- `activeRun`
- `completedRuns`
- `goals`
- `worktrees`
- `lastCompletedStep`
- `nextSuggestedAction`

Install and upgrade flows preserve existing workflow fields when updating state.

Issue execution runs through explicit `plan`, `execute`, and `verify` phases. `workflow.phase` and `workflow.activePhase` record the currently active phase while a phase is running. Completed issue runs return `workflow.phase` to `completed`; failed phase runs set it to `blocked`.

When `verify` fails, AgentRail retries `execute` with the verifier findings as focused input. The default maximum is 5 execution attempts. `activeRun`, `completedRuns`, phase metadata, and `run.json` record `executionAttempt`, `maxExecutionAttempts`, and `failedVerificationAttempts`. After the final failed verify attempt, the run is blocked and `blockedReason` points at the latest verifier findings artifact.

`activeRun` records the issue an agent has picked and is currently working on. It includes the run id, target issue, agent name, status, active phase, picked timestamp, prompt file, metadata file, and run directory. `agentrail run issue` writes this before each phase invocation so a crash, failed compaction, or interrupted terminal still leaves a durable pointer to the in-flight phase.

`completedRuns` is an append-only recent history, capped to the latest 20 runs. Completed and failed runs include completion timestamp and exit status. Failed runs are kept here too because they are part of the recovery trail.

`goals` records operational stop conditions for active or recently completed work. A goal is not motivational copy; it is the condition an agent should satisfy before stopping or asking for review.

Goal records include:

- `id`: stable local identifier such as `issue-123`.
- `kind`: target kind, currently `issue` for issue-scoped Ralph runs.
- `source`: source citation such as `github:issue/123`.
- `status`: `active`, `completed`, or `blocked`.
- `summary`: short human-readable stop condition.
- `successCriteria`: concrete criteria the implementation and PR evidence must satisfy.
- `nonGoals`: explicit boundaries that should not be implemented for this goal.
- `activeIssue`, `activePullRequest`, and `activeMilestone`: current task/review/milestone framing when known.
- `createdAt` and `updatedAt`: ISO timestamps for audit and resume.
- `completedAt`: set when the goal is completed.
- `blockedAt` and `blockedReason`: set when the goal cannot be completed by the current run.

`agentrail run issue <number>` creates or updates an `issue-<number>` goal when the run starts. Successful verification marks the goal `completed`; a failed phase or exhausted verifier retry loop marks it `blocked`. `agentrail status` prints active goals concisely, while verify prompts include active goal success criteria so the verifier compares implementation evidence against the operational stop condition.

`worktrees` records every issue worktree AgentRail creates for AFK execution. Each entry records the issue, optional PR, path, run directory, base branch, timestamps, and lifecycle status. Valid lifecycle statuses are `running`, `completed`, `merged`, `abandoned`, and `failed`.

Merged worktrees are safe cleanup candidates. Failed, abandoned, running, and unmerged completed worktrees are retained unless a maintainer explicitly cleans them. `agentrail cleanup --dry-run --merged` previews merged cleanup candidates. `agentrail cleanup --merged` removes only clean merged worktrees, marks the state entry with `removedAt`, and runs `git worktree prune` first so stale registrations such as `/private/tmp/usePlatoAI-*` are pruned. Use `--force` only when intentionally deleting a merged worktree with uncommitted changes.

Each issue run writes durable phase evidence under `.agentrail/runs/<run-id>/`:

```text
plan/prompt.md
plan/output.md
plan/status.json
plan/metadata.json
execute/prompt.md
execute/output.md
execute/status.json
execute/metadata.json
verify/prompt.md
verify/output.md
verify/status.json
verify/metadata.json
verify/findings.json
execute-2/prompt.md
execute-2/output.md
execute-2/status.json
execute-2/metadata.json
verify-2/prompt.md
verify-2/output.md
verify-2/status.json
verify-2/metadata.json
verify-2/findings.json
```

The first attempt keeps the compatibility paths `execute/` and `verify/`. Retry attempts use numbered directories such as `execute-2/` and `verify-2/`. Each failed verify directory gets `findings.json`. If the verifier output is missing or invalid, AgentRail writes fallback structured findings so the next execute attempt still has consumable recovery input.

The top-level `prompt.md`, `resolved-skills.json`, and `run.json` remain as compatibility pointers for status, resume, and review workflows.

On resume, treat an `activeRun` with no matching live process as stale but useful: inspect its prompt and metadata files, compare with GitHub issue or PR state, then decide whether to rerun, mark blocked, or continue manually. Do not trust chat memory over these files.

The managed inventory includes the skill registry and bundled skill files under `.agentrail/skills/`. Local edits are preserved by `agentrail upgrade` unless `--force` is used.

## Runner Config

`.agentrail/config.json` stores one active runner:

```json
{
  "schemaVersion": 1,
  "runner": {
    "name": "codex",
    "command": "codex exec --sandbox danger-full-access -"
  }
}
```

Built-in names are `codex`, `claude`, `cursor`, and `hermes`. Use `custom` with a command string for unsupported tools. `agentrail run` resolves this config once and uses the same runner for generated prompts and execution; it does not support separate runners per workflow phase.

Before starting execution, `agentrail run` reads `.agentrail/state.json`. Active runs are reported with issue, run directory, prompt, metadata, and next action. When no active run exists, `agentrail run` selects the next open GitHub issue labeled `afk` and `ready-for-agent` while excluding `afk-in-progress`. Use `agentrail run issue <number>` for a known issue and `agentrail afk` for the unattended queue/worktree loop.
