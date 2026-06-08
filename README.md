# AgentRail

AgentRail is a repo-native harness for AI coding agents. It gives agents durable context, workflow state, bounded issue execution, review loops, and verification gates so agent work is easier to inspect, resume, and trust.

AgentRail uses a state-first execution model. Start with `agentrail status` and `agentrail resume`, then let `agentrail run`, `agentrail run issue 123`, or `agentrail afk` decide the next safe execution step from `.agentrail/state.json` before any worker starts new work.

AgentRail is the harness. The configured runner is the worker, such as Codex, Claude, Cursor, Hermes, or a custom command. Ralph is the internal one-issue executor AgentRail invokes during issue execution. AFK is the queue/worktree loop for unattended batches of eligible issues.

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
skills/useagentrail/
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

The public `scripts/agentrail` file is a compatibility launcher. Context-engine behavior is implemented in the typed Python package under `agentrail/context/`; non-context workflow commands currently delegate to the legacy compatibility command under `.agentrail/source/scripts/agentrail-legacy` in installed projects.

## Server & Ingestion Pipeline

The `agentrail/server/` package implements the ingestion and telemetry backend:

- **`ingestion.py`** — `IngestionEnvelope` model and `BatchWriter` for routing submissions to domain stores.
- **`queue.py`** — `QueuedIngestionPipeline` with pre-enqueue validation, unknown-kind rejection, and async batch flushing.
- **`product.py`** — `ProductAuthStore` Protocol and `InMemoryProductAuthStore` for workspace, team, API key, repository, indexer, run, review gate, source custody policy, and billing configuration records.
- **`telemetry.py`** — `TelemetryStore` Protocol and `InMemoryTelemetryStore` for index snapshots, graph metadata, context pack metadata, artifact references, and all event kinds (run, cost, audit, failure, command, context). Includes idempotent deduplication for metadata submissions and a `query_events()` filter API.

Protocol classes use `TYPE_CHECKING` guard imports to avoid circular dependencies while keeping type annotations resolvable by static checkers:

```python
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from agentrail.server.ingestion import IngestionEnvelope

class TelemetryStore(Protocol):
    def write(self, envelope: "IngestionEnvelope") -> None: ...
```

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
    "command": "codex exec --sandbox danger-full-access -"
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

## Context Packs

AgentRail can build local, auditable context packs for issue execution and PR review. Packs are written as JSON and Markdown under `.agentrail/context/packs/`.

```bash
agentrail context query "issue 123 payment retry tests" --target . --json
agentrail context evaluate docs/agents/context-retrieval-fixtures.json --target . --json
agentrail context build issue 123 --phase execute --target . --json
agentrail context build pr 45 --phase review --target . --json
agentrail context show issue-123-execute-20260604T120000000Z --target . --json
agentrail context explain issue-123-execute-20260604T120000000Z --target . --json
```

The context engine internals live under `agentrail/context/`:

- **`compiler.py`** — Context Compiler orchestrator: anchors, candidates, graph expansion, reranking, token budgets, and pack assembly.
- **`embeddings.py`** — Embedding-based retrieval and BM25 seed scoring for candidate ranking.
- **`redaction.py`** — Source custody and snippet redaction policy enforcement.
- **`evaluation.py`** — Retrieval evaluation against fixture-defined expected sources, recall metrics, and exclusion checks.
- **`index.py`** — Index snapshot management and file-level metadata.
- **`models.py`** — Shared data models for context packs, queries, and compiler metadata.
- **`config.py`** — Context engine configuration (budgets, provider modes, policy).
- **`packs.py`** — Pack I/O: reading, writing, and listing generated context packs.

Generated packs include cited required context, likely files and docs, memory, prior mistakes, active state, available tools and skills, exclusions, open questions, retrieval budget, index metadata, provider mode, audit metadata, and Context Compiler metadata when available.

Provider-facing JSON includes command, target, retrieval budget, provider, and audit metadata so agents can request context without parsing Markdown. The `compiler` object is an additive `context-compiler-v1` contract with anchors, candidates, graph expansion status, source custody and snippet policy, redaction state, authority/freshness policy effects, rerank metadata, token pack metadata, citations, reasons, metrics, and compatibility mappings. Existing `results`, `excluded`, pack sections, `jsonPath`, and `markdownPath` remain stable for older consumers.

The installed contract reference is `docs/agents/context-compiler-contract.md`. The future MCP-compatible surface should map to narrow tools such as `context_research`, `context_get_sources`, `context_build_pack`, and `context_explain_pack`; those tools use AgentRail allow/deny and redaction controls rather than unrestricted filesystem access.

Retrieval evaluation fixtures define task text, expected files, expected docs, expected memory, expected prior mistakes, and expected excluded sources. Reports include required-source inclusion, recall@5, recall@10, stale-source exclusion, and citation coverage. CI should run these fixtures for business-critical context paths so missed required context and denied-source leaks fail before review.

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

Use the state-first execution model when you want AgentRail to decide what needs attention. Inspect state first:

```bash
agentrail status
agentrail resume
```

Then run the next eligible issue:

```bash
agentrail run
```

`agentrail run` reads `.agentrail/state.json` first. If an active run exists, it prints the issue, run directory, prompt, metadata, and next action instead of starting new work. If no active run exists, it selects the next open GitHub issue labeled `afk` and `ready-for-agent`, excluding issues already labeled `afk-in-progress`.

Run a specific issue when you already know the target:

```bash
agentrail run issue 123
```

The explicit issue path still checks durable state first and refuses to start conflicting active work.

Run the AFK queue/worktree loop when you want unattended batches:

```bash
agentrail afk
```

Specify the worker engine and concurrency:

```bash
agentrail afk --engine claude --concurrency 2 --max-waves 5
```

Built-in engine names: `codex`, `claude`, `cursor`, `hermes`. Concurrency controls how many issue worktrees run in parallel per wave. Max-waves caps the number of select→execute→review cycles before the run exits.

AFK runs each issue, reviews the resulting PR, creates review-fix issues when the review finds blockers, and prepares/merges reviewed PRs that have no fix issues. When the review produces memory-suggestion issues (docs/process improvements discovered during review), those are queued back into the ready pool and picked up in subsequent waves. Merge automation then promotes any newly unblocked dependent issues back into the ready queue.

Issue runs execute one plan phase, then repeat execute and verify until verification passes. When verify fails, AgentRail writes structured findings under the verify attempt directory and passes them into the next execute attempt. The default limit is 5 execution attempts; after that the run is marked blocked with the latest findings and next action in `.agentrail/state.json`.

### Review Loop & Memory Suggestions

After a PR passes verification, AFK runs a machine-readable review. The review output is a JSON block with two arrays:

- **`fix_issues`** — Concrete code problems that must be fixed before merge. AFK creates GitHub issues labeled `memory-suggestion` (or the appropriate fix label) and blocks the merge.
- **`memory_suggestions`** — Process/docs improvements discovered during review. AFK creates `[memory-suggestion]` issues and queues them for future waves.

When a review finds no fix issues, AFK merges the PR (squash merge with commit SHA validation). If `rg` is unavailable, the `afk_direct_merge()` fallback uses `gh pr merge --squash` directly. If branch protection blocks immediate merge, AFK attempts `--auto` merge enablement.

Memory-suggestion issues feed back into the AFK queue. Subsequent waves pick them up, implement the docs/memory change, open a PR, review it, and merge — creating a self-improving loop where each batch of work refines the project's failure-pattern documentation.

## How To Use It With An Agent

Start with `CONTEXT.md`. Keep the product, domain language, constraints, and repo-specific decisions there. The workflow works poorly if `CONTEXT.md` is empty or stale.

Customize `TASTE.md` when the project has product quality expectations that should guide agents: UI standards, copy tone, interaction preferences, visual evidence expectations, and anti-patterns. If the project is backend-only or has no useful taste guidance yet, missing `TASTE.md` is only a recommendation, not a blocker.

Use `docs/memory/` for source-linked lessons, preferences, and recurring failure patterns that should survive across agent runs. Memory is advisory; agents still need to verify it against current code and canonical docs.

Recall project memory before non-trivial work in an installed project:

```bash
agentrail memory recall "<feature, issue, PR, or keyword>"
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

AFK issue worktrees are AgentRail-owned state. AgentRail records each created issue worktree in `.agentrail/state.json` with lifecycle status `running`, `completed`, `merged`, `abandoned`, or `failed`. After a reviewed PR is merged, AgentRail marks the issue worktree `merged` and runs merged cleanup. Failed and unmerged worktrees are retained for inspection.

Preview and run merged worktree cleanup:

```bash
agentrail cleanup --dry-run --merged
agentrail cleanup --merged
```

Cleanup prunes stale git worktree registrations first. It never removes a worktree with uncommitted changes unless `--force` is passed.

## Dogfooding AgentRail

Maintainers can run the AFK workflow from this AgentRail source repo without installing generated project templates over the source checkout:

```bash
agentrail afk --dry-run
```

Internal/debug only: when debugging AgentRail source scripts themselves, maintainers may use the template runner directly:

```bash
templates/scripts/afk-workflow run --concurrency 1 --max-waves 1 --dry-run
```

For a bounded real wave through the CLI, keep the run small:

```bash
agentrail afk --concurrency 1 --max-waves 1
```

The source repo does not need root-level raw workflow helpers such as `scripts/ralph-loop`, `scripts/review-pr`, or `scripts/memory`. AFK runs through the `agentrail` CLI and keeps helper resolution inside AgentRail source assets. That keeps source-repo self-hosting separate from installing AgentRail into a target project.

AFK dogfooding still requires `.agentrail/state.json` in the repo where the runner starts, but do not run `agentrail install --target .` in this source checkout. That installs target-project templates over the package source and can send agents down the wrong workflow. Create source dogfood state deliberately, keep `.agentrail/` and `.afk-workflow/` untracked, and set `AGENTRAIL_ALLOW_SOURCE_RUN=1` only for intentional source dogfooding.

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
- `.agentrail/state.json`: durable workflow pointer for compaction recovery, handoffs, active issue/PR state, active run state, AgentRail-owned worktree lifecycle, retry attempts, recent completed/failed runs, and next suggested action.

AgentRail is local CLI workflow infrastructure, not a hosted orchestration platform. Keep runs bounded, review PRs before merge, and verify changes with the commands recorded in each PR.

## Common Commands

Check state and recover context:

```bash
agentrail status
agentrail resume
```

Run the next queued issue:

```bash
agentrail run
```

Run one issue through AgentRail:

```bash
agentrail run issue 123
```

Run the AFK queue/worktree loop:

```bash
agentrail afk
agentrail afk --engine claude --concurrency 2 --max-waves 5
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

Older AgentRail installs placed raw workflow helpers under `scripts/`. New installs keep those helpers out of the normal project surface and route agents through the `agentrail` CLI. The installed `scripts/agentrail` file is a compatibility shim for package installs; normal docs and prompts should say `agentrail ...`.

Use these replacements:

```text
scripts/memory recall ...        -> agentrail memory recall ...
scripts/ralph-loop --issue 123   -> agentrail run issue 123
scripts/afk-workflow run ...     -> agentrail afk
legacy PR review helper          -> agentrail prompt review 123
scripts/agentrail doctor ...     -> agentrail doctor ...
scripts/agentrail upgrade ...    -> agentrail upgrade ...
```

`agentrail doctor` reports legacy raw workflow scripts when it finds them. After checking for local edits, remove the old `scripts/memory`, `scripts/ralph-loop`, `scripts/afk-workflow`, `scripts/review-pr`, and `scripts/pr` files from installed projects. Keep `scripts/agentrail`; it is the supported package shim behind the `agentrail` command.

Internal/debug only: maintainers debugging AgentRail itself can still use the internal helpers from a source checkout:

```bash
templates/scripts/afk-workflow run --concurrency 1 --max-waves 1 --dry-run
```

## Requirements

The scripts expect the target project to be a git repo. Depending on the command, they may also require:

- `gh` — GitHub CLI for issue/PR operations (required for AFK)
- `jq` — JSON processing (required for AFK)
- `rg` — ripgrep for PR review file analysis (optional; AFK falls back to direct `gh pr merge` when unavailable)
- `codex` — Codex worker (required when engine is `codex`)
- `pnpm` — package management
- `node` — Node.js runtime

Run:

```bash
npm test
```

from this workflow repo to verify the installer.
