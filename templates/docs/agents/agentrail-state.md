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
- `lastCompletedStep`
- `nextSuggestedAction`

Install and upgrade flows preserve existing workflow fields when updating state.

The managed inventory includes the skill registry and bundled skill files under `skills/`. Local edits are preserved by `agentrail upgrade` unless `--force` is used.
