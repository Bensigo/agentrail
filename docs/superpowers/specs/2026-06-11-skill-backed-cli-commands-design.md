# Skill-backed CLI commands + enterprise distribution

**Date:** 2026-06-11
**Status:** Approved design — pending spec review
**Related issues:** #404 (installer installs files, not flow — distribution shares its "CLI vs project files" boundary). Unrelated open issues left as-is: #398, #399, #400, #401, #402, #403.

## Problem

The project's planning skills (`to-prd`, `to-milestones`, `to-issues`, `grill-with-docs`) are only reachable by an agent invoking them ad-hoc. There is no first-class way for a user to run `agentrail issue create` and get the house issue flow. AgentRail is now an enterprise CLI, so these flows should be real commands, and the tool should install like an enterprise CLI (brew/curl), not depend solely on npm.

Direct trigger: issues #398–#403 were first created freeform with raw `gh issue create` instead of the `to-issues` house template — exactly the gap a first-class `agentrail issue create` closes.

## Goals

- First-class commands `agentrail issue create`, `agentrail prd create`, `agentrail milestone create`, `agentrail grill-me`, each backed by its existing skill.
- Each command runs the configured agent (claude/codex) seeded with the skill + house context. **Interactive by default** (the skills quiz the user one question at a time); **`--headless`/`--yes`** for unattended/CI.
- The skill `SKILL.md` stays the single source of truth — commands load it verbatim, they do not re-implement the procedure.
- Enterprise distribution: Homebrew + `curl | sh`, keeping npm. brew/curl install the **CLI**; `agentrail init` installs **project files** (consistent with #404).

## Non-goals (v1)

- No `list`/`view`/`sync` subcommands — `create` + `grill-me` only.
- No re-implementation of skill procedures in Python (load `SKILL.md` as-is).
- No change to the existing `run`/`afk`/`prompt` agent paths.
- Not removing or changing npm packaging beyond adding release artifacts.

## Architecture

### 1. The skill-backed agent session primitive

New module `agentrail/skillcmd/session.py` — one reusable primitive all four commands share.

```
run_skill_session(
    skill_name: str,          # e.g. "to-issues"
    target_dir: str,
    input_refs: list[str],    # PRD path, milestone path, plan text/file, issue ref…
    *,
    agent: str, command: str, # from resolve_agent_name/resolve_agent_command (run.py)
    headless: bool,
    extra_context: list[str], # which house files to inline (CONTEXT.md, TASTE.md, …)
) -> int
```

Steps:
1. **Load skill** — read `skills/<skill_name>/SKILL.md` verbatim from the CLI's own skills dir (the canonical copy, not a project-mutable one — see #404).
2. **Assemble seed prompt** — skill body + mandated house context (`CONTEXT.md` always; `TASTE.md`, `docs/agents/triage-labels.md`, `docs/agents/issue-tracker.md`, milestone/issue templates when relevant) + the resolved input refs. Reuse existing prompt-assembly helpers in `agentrail/run/` where they fit; add a small `skillcmd/prompts.py` for the seed framing.
3. **Invoke the agent** — see §2.

Thin command wrappers in `agentrail/cli/commands/{issue,prd,milestone,grill}.py` bind a skill + input shape to the primitive and route from `main.py` (the existing `if args[0] == "<cmd>"` chain). `issue`/`prd`/`milestone` take a `create` subcommand (`args[1] == "create"`); `grill-me` is a single verb.

### 2. Interactive vs headless agent invocation (the one hard part)

Today every agent command is **headless** (`claude -p --dangerously-skip-permissions`, `codex exec … -`). Interactive is new.

- **Headless (`--headless`/`--yes`):** reuse the resolved headless command, feed the seed prompt on stdin (as `run` does), capture output. No user prompts; publishes directly. CI/AFK-safe.
- **Interactive (default):** derive the agent's interactive form from the resolved command and exec it with **inherited stdio** so the agent owns the TTY and can quiz the user:
  - claude: drop `-p` (positional/initial message seeds the session, permissions flag retained per config).
  - codex: `codex` (interactive) instead of `codex exec`.
  - A per-agent `INTERACTIVE_COMMANDS` map mirrors the existing `DEFAULT_COMMANDS`, with the same env/`config.json` override points. `custom`/`cursor`/`hermes`: require the user to provide an interactive command or fall back to headless with a warning.

The primitive writes the seed prompt to a temp file and passes it as the initial message; on interactive exit it returns the agent's exit code.

### 3. Per-command behavior

| Command | Skill | Input | Output / side effect |
|---|---|---|---|
| `agentrail grill-me [plan-or-path]` | `grill-with-docs` | a plan/idea (arg, file, or conversation note) | interactive grilling; edits `CONTEXT.md`/ADRs inline. **No publish.** Ships first — lowest blast radius. |
| `agentrail issue create` | `to-issues` | a milestone path or PRD ref | publishes GitHub issues via the house template + triage labels (`gh`). |
| `agentrail milestone create` | `to-milestones` | a PRD ref/path | writes `docs/milestones/NNN-<slug>.md` local files. |
| `agentrail prd create` | `to-prd` | an idea/brief | writes a PRD and publishes it to the tracker with `ready-for-agent`. |

Flags shared by all: `--agent`, `--target`, `--headless`/`--yes`. `issue`/`prd` honor a `--dry-run` that builds the artifact but does not call `gh` (prints what it would publish) — important for an enterprise tool whose default publishes.

### 4. Enterprise distribution

Three channels; npm stays.

- **Homebrew** (`tap bensigo/homebrew-agentrail`): formula depends on `python@3.x`, installs the stdlib-only `agentrail` package into `libexec`, symlinks the `agentrail` launcher into `bin`. Versioned to GitHub Releases.
- **curl | sh**: `curl -fsSL https://…/install.sh | sh` — checks `python3` present, downloads the pinned release tarball, installs to `~/.agentrail/<version>`, symlinks/adds `agentrail` to PATH, prints PATH guidance. Idempotent; `AGENTRAIL_VERSION` override.
- **CI release artifact**: a workflow builds a versioned tarball (the `agentrail/` package + `scripts/agentrail` launcher + skills/templates the CLI ships) and attaches it to a GitHub Release. The formula and `install.sh` resolve the latest (or pinned) release.

Boundary (per #404): brew/curl/npm install the **CLI itself** (the flow, immutable, runs from the installed package). `agentrail init` installs **project-owned files** into a repo. Two clean layers.

## Testing

- **Unit:** seed-prompt assembly (skill body + correct house files inlined) per command; interactive-vs-headless command derivation per agent (mock `resolve_agent_command`); `--dry-run` builds artifact without `gh`. Mock subprocess + `gh`.
- **Headless e2e (hermetic):** stub agent emits a canned issue body; assert `agentrail issue create --headless --dry-run` produces a house-template issue and (with publish) calls `gh` with the right labels. Temp git repo, no network.
- **Distribution:** `shellcheck` on `install.sh`; a dry-run install test (stub release tarball) asserting the launcher lands on PATH and `agentrail --help` runs. Homebrew formula audited with `brew audit --strict` in CI if feasible, else a syntax check.

## Build order → issues (vertical slices, house template)

1. **`skillcmd` primitive + `agentrail grill-me`** — interactive, no publish. Proves the seed+invoke pattern at lowest blast radius. *(ready-for-agent)*
2. **`agentrail issue create`** — highest value; interactive + `--headless` + `--dry-run`; house template + triage labels. *(ready-for-agent)*
3. **`agentrail milestone create`** — PRD → `docs/milestones/`. *(ready-for-agent)*
4. **`agentrail prd create`** — idea → PRD + publish. *(ready-for-agent)*
5. **Homebrew formula + CI release tarball.** References #404. *(ready-for-agent)*
6. **`curl | sh` installer** (depends on the release tarball from #5). *(ready-for-agent)*

## Open questions

- Interactive seeding: does `claude` (current version) accept an initial message as a positional arg cleanly, or is `--append-system-prompt` + an opening user turn better? Verify against the installed CLI during slice 1.
- `prd create` publishing target: the `to-prd` skill publishes the PRD to the issue tracker — confirm that's still desired vs. also writing a local `docs/prd/` file.
- Homebrew tap location: personal tap now, homebrew-core later (needs notability + license review).
