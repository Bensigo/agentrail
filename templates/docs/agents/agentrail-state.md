# AgentRail State

AgentRail stores repo-local project state in `.agentrail/state.json`.

This file is intended for manual inspection by agents and maintainers. It records installation metadata, the files AgentRail manages, and the current workflow pointer so work can resume without relying on chat memory.

AgentRail also installs `docs/agents/skill-registry.json`. The registry is a managed artifact that describes bundled skills, their local `SKILL.md` paths, activation triggers, provenance candidates, license status, audit status, and default bundling behavior.

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
- `activeIssue`
- `activePullRequest`
- `activePrd`
- `activeMilestone`
- `activeRun`
- `completedRuns`
- `lastCompletedStep`
- `nextSuggestedAction`

Install and upgrade flows preserve existing workflow fields when updating state.

`activeRun` records the issue an agent has picked and is currently working on. It includes the run id, target issue, agent name, status, picked timestamp, prompt file, metadata file, and run directory. `agentrail run issue` writes this before invoking the agent command so a crash, failed compaction, or interrupted terminal still leaves a durable pointer to the in-flight work.

`completedRuns` is an append-only recent history, capped to the latest 20 runs. Completed and failed runs include completion timestamp and exit status. Failed runs are kept here too because they are part of the recovery trail.

On resume, treat an `activeRun` with no matching live process as stale but useful: inspect its prompt and metadata files, compare with GitHub issue or PR state, then decide whether to rerun, mark blocked, or continue manually. Do not trust chat memory over these files.

The managed inventory includes the skill registry and bundled skill files under `skills/`. Local edits are preserved by `agentrail upgrade` unless `--force` is used.
