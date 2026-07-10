# Contributing to AgentRail

AgentRail is the control plane for AI coding agents: durable context, bounded
issue execution, review loops, and verification gates. This guide gets you from
a clean checkout to a green local run so you can land a change with confidence.

The commands below are exactly what CI runs (`.github/workflows/ci.yml`). If a
command passes here, it passes in CI.

## Prerequisites

- **Python 3.11** — matches the CI runner. 3.9+ installs, but verify against 3.11.
- **Node.js 18+ and pnpm** — for the console, MCP, and database packages.
- **shellcheck** — lints `install.sh` and the install test script.
- **git** — the harness and several tests operate on real git repos.

Optional, depending on what you touch:

- **gh** (GitHub CLI) and **jq** — required for issue/PR operations and AFK.
- **Docker** — required only for the Postgres/ClickHouse-backed console work.

## Setup

Clone the repo and install both toolchains.

Python (editable install, so `pyproject.toml` dependencies such as
`tree-sitter` are available to the Context Compiler and Local Indexer tests):

```bash
python -m pip install --upgrade pip pytest -e .
```

Node workspaces (only needed for console / MCP / database changes):

```bash
pnpm install
```

## Running tests

These are the three CI gates. Run all three before opening a PR.

### 1. Python suite

```bash
python -m pytest -q
```

This is the bulk of the suite — the Local Indexer, Context Compiler, Issue
Queue, CLI, and run logic. Tests that need the optional `agentrail` shim or a
built MCP `dist` skip cleanly when those are absent, exactly as they do in CI.

### 2. Shell lint

```bash
shellcheck install.sh agentrail/scripts/test-install.sh
```

### 3. Installer hermetic test

```bash
bash agentrail/scripts/test-install.sh
```

This exercises the public installer end to end (happy-path install,
idempotency, version pin, and the missing-`python3` error path) in a temporary
directory, so it never touches your working tree.

## Lint and typecheck (console / Node changes)

If your change touches the Agent Operations Console or other Node packages, also
run:

```bash
pnpm lint
pnpm typecheck
```

These are scoped to the `@agentrail/console` workspace and are not part of the
PR-gating CI workflow, but keep the console green before pushing UI changes.

## Conventions

- Keep contributor-facing docs consistent with the glossary in `CONTEXT.md`
  (**AgentRail Server**, **Local Indexer**, **Context Compiler**, **Issue
  Queue**, **Heartbeat**). Use the project's domain language, not generic terms.
- Apply the copy tone in `TASTE.md`: direct, concrete, operational. No hype.
- The console display rule applies to the README and dashboards: only add
  *falsifiable* status (numbers or badges that can come back negative or red).
  No vanity badges.
- UI-visible changes need a screenshot or short video of the actual changed
  surface — test output is not visual evidence.

## Opening a pull request

1. Branch off `main` (`feat/...` or `fix/...`).
2. Make the three CI gates above pass locally.
3. Fill in `.github/PULL_REQUEST_TEMPLATE.md` — link the parent issue, list the
   acceptance criteria, and paste the verification evidence (command tails,
   screenshots).
4. Push and open the PR against `main`. CI must be green before merge.

## Reporting security issues

Do **not** open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md)
for the private disclosure path.
