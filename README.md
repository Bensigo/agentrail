# AgentRail — the factory behind Jace

[![CI](https://github.com/Bensigo/agentrail/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Bensigo/agentrail/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[Jace](https://heyjace.com) is an AI engineer you hire onto your team. You
talk to him in chat. He helps turn a rough idea into a concrete issue,
confirms goal, approach, and cost with you before any work starts, then works
the issue through a real development cycle — a failing test first, an
implementation, an independent review, a verification gate — and opens a pull
request. He does not merge by default; you review, and merge rights are yours
to grant.

Jace is open source. This repository is all of him:

- **`apps/jace`** — the coordinator: conversation, ideation skills
  (`grill-me` → PRD → issues), and the chat channels. Telegram is wired
  today; Discord, Slack, iMessage, and WhatsApp are being brought up.
- **`agentrail/`** — the factory: the SDLC engine that takes an approved
  issue to a reviewed, gated pull request. Also usable standalone as a CLI.
- **`apps/console`** — the console at [heyjace.com](https://heyjace.com):
  work board, runs, review gates, costs, approvals — the evidence behind
  every PR.

**Status (2026-07):** the hosted message-first flow — message Jace at
[heyjace.com](https://heyjace.com), zero setup, execution in the cloud — is
being assembled; the design is
[`docs/superpowers/specs/2026-07-17-jace-end-to-end-flow-design.md`](docs/superpowers/specs/2026-07-17-jace-end-to-end-flow-design.md)
and the work is tracked on this repo's issue board. What runs end to end
today: chat with Jace on Telegram, idea → house-format GitHub issue through
his gated create-issue tool, `ready-for-agent` issues executed by a runner to
reviewed PRs, and the console over all of it. Everything below documents
running that yourself — as a self-hoster or a contributor.

Terminology used throughout: AgentRail is the harness. The configured runner is the worker — Codex, Claude, Cursor, Hermes, or a custom command. Ralph is the internal one-issue executor AgentRail invokes during issue execution. AFK is the queue/worktree loop for unattended batches of eligible issues.

It installs:

- `AGENTS.md` — a thin root pointer other agent harnesses read automatically
- `.agentrail/context.md` — the project context file agents should read first
- `.agentrail/agents/` — agent operating docs, state format, and the skill registry
- `docs/prd/` and `docs/milestones/` scaffold folders (still installed today; scheduled for removal now that Jace owns ideation — see "What Gets Installed")
- project-local skills under `.agentrail/skills/` (also duplicated at top-level `skills/` today — a known gap, see "What Gets Installed")
- durable AgentRail state under `.agentrail/state.json`
- AgentRail config under `.agentrail/config.json`

It does **not** create `.agentrail/taste.md` or `.agentrail/memory/` — add
those yourself when you want product-taste guidance or durable project
memory; AgentRail reads them when present.

## Self-hosting: install & quick start

The hosted product runs the runner for you. Self-hosters run it themselves:
your machine, your LLM keys, your custody of the code.

Install the CLI globally from npm:

```bash
npm install -g @useagentrail/cli
```

Log in to your workspace (required):

```bash
agentrail login
```

Start the local runner to claim and execute queued issues:

```bash
agentrail runner
```

The runner polls the console for issues labelled `ready-for-agent`, executes
them locally, opens PRs, and reports back. See
[Self-hosting](https://heyjace.com/docs/getting-started/self-hosting)
for the full sign-up → connect GitHub → runner flow.

Initialize in a project (for local index and workflow files):

```bash
cd your-project
agentrail init
```

Or install into another directory:

```bash
agentrail init --target /path/to/project
```

Overwrite existing installed files:

```bash
agentrail init --target /path/to/project --force
```

Create or update the expected GitHub labels too:

```bash
agentrail init --target /path/to/project --github-labels
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

Then edit `.agentrail/context.md`. Do this before asking agents to plan or implement non-trivial work.

## What Gets Installed

Project docs:

```text
AGENTS.md                (root pointer, managed file)
.agentrail/context.md
.agentrail/agents/
docs/prd/
docs/milestones/
```

`AGENTS.md` is a thin root-level pointer — Claude Code, Codex, and other agent
harnesses read `AGENTS.md` at the repo root automatically, and it directs
agents to `.agentrail/context.md`, `.agentrail/taste.md` (when present), and
`.agentrail/agents/agent-instructions.md` rather than duplicating that content
at the root. `agentrail install`/`agentrail init` write this file's content in
full (tracked in `.agentrail/state.json`, not a marker-delimited block); the
separate `agentrail init <claude|cursor|codex>` subcommand wires per-agent MCP
config and, for `cursor`/`codex` only, additionally appends its own
`<!-- agentrail-mcp:start/end -->`-marked steering block to `AGENTS.md` for
context-retrieval tool guidance — an additive mechanism distinct from the
pointer content described here.

`.agentrail/taste.md` and `.agentrail/memory/` are **not** created by a fresh
install today. Add `.agentrail/taste.md` yourself for product-taste guidance,
or `.agentrail/memory/` for durable project memory — AgentRail's dual-path
readers pick both up as soon as they exist (falling back to legacy
`TASTE.md` / `docs/memory/` for installs that predate the `.agentrail/`
layout and have not yet run `agentrail upgrade`).

`docs/prd/` and `docs/milestones/` scaffold folders are still installed at
the project root today. Dropping them from a fresh install (Jace owns
ideation end to end) is planned but not yet implemented — treat their
presence as current behavior, not something you should build around going
away.

Project-local skills:

```text
.agentrail/skills/useagentrail/
.agentrail/skills/backend-api/
.agentrail/skills/desktop-tauri/
.agentrail/skills/devops-deploy/
.agentrail/skills/docs-current/
.agentrail/skills/frontend-web/
.agentrail/skills/tdd/
```

The CLI reads skills from `.agentrail/skills/`. `.claude/skills/` carries the
same files so Claude Code's own skill discovery finds them — that copy is
intentional harness wiring, not a duplicate. A fresh install **also** still
writes a third copy at top-level `skills/`, predating the `.agentrail/`
layout: that one is a known duplicate, not yet removed. Do not treat
top-level `skills/` as canonical, and expect it to disappear in a future
release without notice.

Upstream planning skills — `grill-me`, `to-prd`, `to-milestones`, `to-issues` — live in the Jace coordinator (`apps/jace/agent/skills/`), not in an installed project. They draft and publish house-template issues; execution here starts from those issues.

AgentRail ships curated first-party skills, not arbitrary third-party hot installs. Upstream projects may be listed in `.agentrail/agents/skill-registry.json` as provenance candidates, but those references are audit notes, not trusted install sources. The installed skills files are the reviewed local copies that prompts point agents to read.

Internal compatibility copy:

```text
.agentrail/source/
```

Installed projects should use the `agentrail` CLI. Raw Ralph, AFK, review, PR, and memory scripts are package internals and are kept under `.agentrail/source/` only for compatibility and upgrades.

The public `scripts/agentrail` file is a compatibility launcher. All commands are implemented as native Python under `agentrail/cli/`.

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

The state file records the AgentRail version, install timestamps, managed file inventory, file hashes, and the current workflow pointer. Its format is documented in `.agentrail/agents/agentrail-state.md`.

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

`agentrail doctor` reports missing core files, optional `.agentrail/taste.md` (or legacy `TASTE.md`), state health, managed file hash drift, old script-first installs, and GitHub label gaps when `gh` is available in a connected GitHub repo. Missing recommendations are warnings; invalid usage and corrupt state fail non-zero.

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

Maintainers should treat upstream skill material as supply-chain input: borrow aggressively, vendor carefully, update intentionally, never auto-trust. Before changing `agentrail/templates/docs/agents/skill-registry.json`, verify the upstream source still exists, record the current URL or observed commit/SHA when available, check the license and audit status, then update the local skill file and tests in the same PR.

## Context Packs

AgentRail can build local, auditable context packs for issue execution and PR review. Packs are written as JSON and Markdown under `.agentrail/context/packs/`.

```bash
agentrail context query "issue 123 payment retry tests" --target . --json
agentrail context evaluate .agentrail/agents/context-retrieval-fixtures.json --target . --json
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

The installed contract reference is `.agentrail/agents/context-compiler-contract.md`. The MCP surface is shipped in `packages/mcp` (`@agentrail/mcp`): an stdio MCP server exposing `context_search`, `context_get`, `context_build_pack`, and `context_explain_pack` so coding agents (Claude, Cursor, Codex) prefer compact AgentRail retrieval over raw filesystem search/read. Each tool maps to the `agentrail context` CLI and respects AgentRail allow/deny and redaction controls. See `packages/mcp/README.md` for wiring a client; `agentrail/tests/context/test_mcp_structural.py` verifies the server end-to-end.

Retrieval evaluation fixtures define task text, expected files, expected docs, expected memory, expected prior mistakes, and expected excluded sources. Reports include required-source inclusion, recall@5, recall@10, stale-source exclusion, and citation coverage. CI should run these fixtures for business-critical context paths so missed required context and denied-source leaks fail before review.

## Recommended Flow

Use the full workflow for product features, risky changes, or work that needs agent handoff:

```text
Jace: grill-me -> to-prd -> to-milestones -> to-issues
-> tdd
-> agentrail run issue
-> agentrail prompt review
-> review-fix
```

The planning steps (idea to house-template issues) run in the Jace coordinator; the rest runs in this project against the issues Jace produces. For small edits, skip the heavy planning steps and implement directly with tests.

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

Memory-suggestion issues feed back into the AFK queue. Subsequent waves pick them up, implement the `.agentrail/memory/` change (or `docs/memory/` on installs that have not migrated), open a PR, review it, and merge — creating a self-improving loop where each batch of work refines the project's failure-pattern documentation.

## How To Use It With An Agent

Start with `.agentrail/context.md`. Keep the product, domain language, constraints, and repo-specific decisions there. The workflow works poorly if `.agentrail/context.md` is empty or stale.

Customize `.agentrail/taste.md` when the project has product quality expectations that should guide agents: UI standards, copy tone, interaction preferences, visual evidence expectations, and anti-patterns. A fresh install does not create this file — add it yourself when it's useful. If the project is backend-only or has no useful taste guidance yet, a missing `.agentrail/taste.md` is only a recommendation, not a blocker.

Use `.agentrail/memory/` for source-linked lessons, preferences, and recurring failure patterns that should survive across agent runs. A fresh install does not create this directory either — add it yourself when you want durable project memory. Memory is advisory; agents still need to verify it against current code and canonical docs.

Recall project memory before non-trivial work in an installed project:

```bash
agentrail memory recall "<feature, issue, PR, or keyword>"
```

When you want to work on a new feature, ask the Jace coordinator to grill the idea first:

```text
Use grill-me. I want to build <feature idea>. Challenge the idea against this repo's `.agentrail/context.md` and codebase before we write a PRD.
```

Use `grill-me` when:

- the feature is vague
- the user, outcome, or non-goals are unclear
- the change touches important domain behavior
- you are not sure what should be built first

After the idea is clear, turn it into a PRD (still in the Jace coordinator):

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

AgentRail routes Codex prompts toward repo-local skills and docs. For example, a grill prompt points Codex at `grill-me`; an issue prompt points it at AgentRail issue execution, which invokes Ralph internally during the execute phase; a review prompt points it at PR review instructions. Claude prompts use the same AgentRail intent but refer to local instruction files instead of Codex-specific skill mechanics.

The main context files fit together like this:

- `AGENTS.md`: thin root pointer with operating rules agents should follow in this repo.
- `.agentrail/context.md`: product, domain, architecture, and repository facts.
- `.agentrail/taste.md`: optional product quality, UI, copy, interaction, and visual evidence guidance — not created by a fresh install; add it yourself when useful.
- `.agentrail/memory/`: source-linked lessons, decisions, preferences, and failure patterns to recall before non-trivial work — not created by a fresh install; add it yourself when useful.
- GitHub issues: implementation source of truth, acceptance criteria, blockers, and AFK eligibility.
- `.agentrail/state.json`: durable workflow pointer for compaction recovery, handoffs, active issue/PR state, active run state, AgentRail-owned worktree lifecycle, retry attempts, recent completed/failed runs, and next suggested action.

The factory CLI is the local workflow layer under Jace. The hosted product lives at [heyjace.com](https://heyjace.com); self-hosters run the same factory with their own runner and keys. Either way: keep runs bounded, review PRs before merge, and verify changes with the commands recorded in each PR.

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
legacy PR review helper          -> agentrail prompt review 123
scripts/agentrail doctor ...     -> agentrail doctor ...
scripts/agentrail upgrade ...    -> agentrail upgrade ...
```

`agentrail doctor` reports legacy raw workflow scripts when it finds them. After checking for local edits, remove the old `scripts/memory`, `scripts/ralph-loop`, `scripts/afk-workflow`, `scripts/review-pr`, and `scripts/pr` files from installed projects. Keep `scripts/agentrail`; it is the supported package shim behind the `agentrail` command.

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

## Repository Layout

AgentRail's own code — the factory that runs coding agents — lives entirely
under `agentrail/`:

```text
agentrail/
  cli/          # command implementations (init, run, afk, doctor, ...)
  run/          # execute/verify pipeline, prompts, skills resolution
  context/      # Context Compiler: retrieval, ranking, packs
  guardrails/   # policy gate (safety floor: secrets, tests, green CI)
  afk/          # unattended queue/worktree loop
  heartbeat/    # event/cadence dispatcher
  runner/       # runner protocol + built-in engines
  sandbox/      # sandboxed execution
  server/       # ingestion + telemetry backend
  evals/        # eval harness
  connectors/   # inbound issue sources
  shared/       # shared utilities
  templates/    # shipped payload copied into installed projects
  skills/       # shipped payload copied into installed projects
  tests/        # pytest suite (excluded from the wheel and npm package)
  scripts/      # CLI launcher + dev/benchmark/test scripts
  docker/       # sandbox runner image
```

`apps/console` (hosted dashboard), `apps/jace` (the Eve-based coordinator),
and `packages/` (shared TypeScript packages) live alongside `agentrail/` at
the repo root. `docs/` holds product PRDs, ADRs, audits, and design specs —
human-facing project history, not installed-project content.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev
setup and the exact commands CI runs (Python suite, shellcheck, installer
test) — if they pass locally, they pass in CI. Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md).

To report a security vulnerability, do **not** open a public issue — follow the
private disclosure path in [`SECURITY.md`](SECURITY.md).

## License

AgentRail is licensed under the [Apache License 2.0](LICENSE).
