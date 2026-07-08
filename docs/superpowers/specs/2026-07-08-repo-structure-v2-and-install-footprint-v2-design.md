# Repo Structure v2 & Install Footprint v2 — Design

**Date:** 2026-07-08
**Status:** Approved direction (this doc is the review artifact)
**Owner:** bensigo
**Grounding:** six-agent tech-debt + Jace-descope audit (2026-07-08); scope split locked 2026-07-02 (Jace = ideation→issues + channels; AgentRail = pure SDLC factory); multi-tenant cloud plan PR #1101.

## 1. Problem

Two distinct messes make the project hard to navigate for both humans and agents:

1. **The product repo** mixes the factory package, shipped payload, dead folders from superseded eras, and ~14 GB of local caches across ~45 top-level entries. "Where does AgentRail code live?" has five answers.
2. **Installed repos** (what `agentrail init` writes into a user's codebase) scatter files across the user's root, `docs/`, `skills/`, and `.claude/` — interleaved with the user's own files, collision-prone, with no visual ownership boundary.

Context: the repo is going private soon and the hosted side is moving to the cloud (PR #1101), so open-source top-level conventions carry less weight than internal legibility.

## 2. Locked decisions

- **D1 — One product dir:** everything factory-related lives inside `agentrail/` — including `templates/`, `skills/`, `tests/`, `scripts/`, and `docker/` (sandbox image). Chosen over the conventional tests-at-root layout; the packaging risks are handled by guards (§4).
- **D2 — One install dir:** everything `agentrail init` installs into a user repo lives under `.agentrail/`, with exactly two harness-mandated exceptions: a thin root `AGENTS.md` pointer (managed block) and `.claude/` wiring (hooks + the skills copy Claude Code reads).
- **D3 — Tracked content, ignored caches:** `.agentrail/` ships its own `.gitignore` ignoring `context/`, `runs/`, `batch/`, `*.log`; content dirs (`agents/`, `skills/`, `memory/`, `context.md`, `taste.md`, `config.json`, `verify.sh`, `hooks/`) are committable. `server.json` (secrets) is ignored.
- **D4 — Automatic migration:** `agentrail upgrade` physically moves legacy-layout files into `.agentrail/`; runtime readers accept new path first, legacy path as fallback for one release with a `doctor` warning; fallback removed the release after.
- **D5 — Install less:** stop installing `docs/prd/` + `docs/milestones/` scaffolds (Jace owns ideation) and the duplicate top-level `skills/` copy (single copy at the location the runtime actually reads — verify reader during implementation).
- **D6 — Not doing:** `agentrail/` does not move under `apps/` (pnpm-workspace semantics, packaging blast radius, no benefit). Engineering skills (backend-api, frontend-web, tdd, …) stay in the factory — they are execution-time discipline packs, not coordination content. Runtime contract files stay local files, not Jace-RAG lookups (network coupling + injection surface; factory must run self-contained).

## 3. House 1 — product repo target layout

```
agentrail/                      # the factory (Python package)
  cli/ run/ context/ guardrails/ afk/ heartbeat/
  runner/ sandbox/ server/ evals/ connectors/ shared/
  templates/                    # ← moved from /templates   (shipped payload / package data)
  skills/                       # ← moved from /skills      (shipped payload / package data)
  tests/                        # ← moved from /tests       (excluded from wheel + npm)
  scripts/                      # ← moved from /scripts     (slimmed first, §5 PR-1)
  docker/                       # ← moved from /docker      (sandbox runner image)
apps/console                    # hosted console (Next.js)
apps/jace                       # coordinator (Eve)
packages/                       # shared TS packages
docs/                           # product PRDs / ADRs / audits / specs (human-facing; stays)
docker-compose.yml              # console local dev stack (`agentrail console` boots it; stays at root)
+ root meta: README, CLAUDE.md, CONTEXT→(migrates per House 2), LICENSE, SECURITY,
  CONTRIBUTING, CODE_OF_CONDUCT, pyproject.toml, package.json, pnpm-*, install.sh,
  npm-README.md, .npmignore, .github/, .claude/, .gitignore
```

**Deletions folded in (from the 2026-07-08 audits):** `milestones/` (superseded by `docs/milestones/`), `output/` (superseded by `docs/screenshots/`), `Formula/` (Homebrew placeholder, channel never launched), `scripts/benchmark-latency.py`, `scripts/test-context-benchmark` (zero references), `scripts/test-mcp` (doc-only; delete with README fixup). Ideation CLI removal (grill/prd/milestone) proceeds in the parallel de-scope arc and shrinks what moves.

## 4. Guards that make D1 safe

- **pyproject:** package discovery excludes `agentrail.tests*` (and non-package dirs as needed); `templates/`, `skills/`, `docker/` declared as package data (importlib.resources access where code currently builds paths from repo root).
- **npm:** `package.json` `files` allowlist + `bin` path updated (`agentrail/scripts/agentrail`); `.npmignore` safety net updated; `publish.yml` leak-check patterns reviewed.
- **Release/docker:** `release.yml` tarball paths and the sandbox image build context updated to the new locations.
- **pytest:** `testpaths = agentrail/tests`; ensure collection ignores installed-package copies.
- **CI:** `ci.yml` path updates (pytest, shellcheck on `install.sh` + moved scripts, `test-install.sh` invocation path).
- **Vendoring simplifies:** `_template_sync.VENDOR_DIRS` collapses from `("agentrail","templates","skills")` to the single package tree; `_build_inventory`/`_materialize_source` walk the new subpaths.
- **Index globs:** moving tests inside the package changes what `agentrail/**` globs match — review default index/code globs so test files rank appropriately in retrieval.

## 5. House 2 — installed footprint target

```
AGENTS.md            # root pointer with managed block (cross-tool convention) → points into .agentrail/
.claude/             # harness wiring only: hook registration + skills copy Claude Code reads
.agentrail/
  .gitignore         # shipped: context/ runs/ batch/ *.log server.json
  config.json  verify.sh  hooks/context-first.sh
  agents/            # ← was docs/agents/*  (ralph-loop, pr-review, github-pr-reviewer,
                     #    skill-registry.json, issue-tracker, state, contracts, …)
  skills/            # ← single skills copy (was top-level skills/ + .claude/skills dupe)
  memory/            # ← was docs/memory/
  context.md         # ← was root CONTEXT.md
  taste.md           # ← was root TASTE.md
```

**Runtime readers to update (new path first, legacy fallback per D4):** `run/prompts.py` (`_resolve_doc`), `run/skills.py` + skill-registry validation in `doctor.py`, `context/sources.py` (agent_doc/memory/prd/milestone sources read `.agentrail/*` and keep reading legacy `docs/*` if present), `run/context_inject.py` (AGENTS.md managed block content), `install.py` / `upgrade.py` / `_template_sync.py`, `scripts/test-install` assertion lists.

**Known traps (from the audits — do not rediscover):**
- The context index currently **excludes `.agentrail`** (PR #1093, deliberate — it was all caches). Default index globs must re-include `.agentrail/{agents,skills,memory}` + `context.md`/`taste.md` while continuing to exclude cache subdirs, or the factory goes blind to its own operating docs.
- `.agentrail/` already holds load-bearing local files (`config.json`, `hooks/context-first.sh`, `verify.sh`, `server.json` with a live API key). Migration must merge into the dir, never recreate it.
- `scripts/test-install` hardcodes required/excluded path assertions — every House-2 PR updates it in the same change.
- This repo is **user-zero**: its own `CONTEXT.md`, `TASTE.md` migrate too; its `docs/prd` + `docs/milestones` stay (product specs, eval fixtures reference specific files) and remain readable via the legacy path in `context/sources.py`.

## 6. Execution plan (small PRs, each independently green)

| # | PR | Depends on |
|---|----|-----------|
| 1 | Deletions: `milestones/`, `output/`, `Formula/`, 3 orphan scripts, eval-log gitignore | — |
| 2 | Move `templates/` + `skills/` into package; vendoring + package-data + npm/release paths | 1 |
| 3 | Move `tests/` + `scripts/` + `docker/` into package; pyproject excludes; pytest/CI paths; npm bin | 2 |
| 4 | Dual-path runtime readers (prompts, skills, sources, doctor, context_inject) | 2 |
| 5 | Installer writes `.agentrail/` layout for fresh installs (incl. shipped `.gitignore`, root AGENTS.md pointer) | 4 |
| 6 | `agentrail upgrade` migration (move files, merge-not-recreate) + `doctor` legacy warning | 5 |
| 7 | Index-glob re-scope for `.agentrail` content | 5 |
| 8 | Docs/README/AGENTS.md narrative update; drop prd/milestones scaffolds + dup skills copy from install | 5 |

Related but **separate arcs** (not this spec): ideation CLI removal (`issue create` blocked on #1101 W4 — Jace shells out to it), channel retirement (paced by #1101 cutover), guardrail shim migration, disk cleanup.

## 7. Verification

Per PR: full pytest suite, `scripts/test-install` (hermetic install test), `npm test` chain still green, `agentrail doctor` clean on this repo, and a scratch-repo `agentrail init` + `upgrade` (legacy fixture) smoke for House-2 PRs. Console/browser verification not required (no UI surface changes).
