# Milestone 004 — Port `install-workflow` to native Python (closes #404)

Source: `docs/superpowers/specs/2026-06-12-eliminate-bash-design.md` (M4).

## Outcome

`scripts/install-workflow` (334 lines) is deleted; `agentrail install` is pure Python. The installer writes **only project-owned files** (`docs/agents`, `.claude`/`.codex` config, skills content, CONTEXT/TASTE scaffolding) and stops vendoring `.agentrail/source` flow scripts. Reproducible pinning uses a recorded version + the launcher resolving the installed package. **Closes #404.**

## Why next

Depends on M002+M003 — once the flow is entirely native in the package, the installer no longer needs to copy it into projects.

## Testable proof

`agentrail install` on a clean temp dir produces the correct project-owned files, **no** `.agentrail/source/`, and a recorded version matching the installed package; `python -m pytest tests/cli/test_install_cli.py` green; `scripts/install-workflow` absent.

## Likely issue slices

- Audit all files `install-workflow` writes; classify project-owned vs flow-script
- Port file-copy + content-hash manifest to `cli/commands/install.py`
- Drop the `.agentrail/source` flow-script vendoring
- Implement recorded-version + launcher-resolves-installed-package pinning (#404 AC3)
- Update `install` CLI tests
- Delete `scripts/install-workflow`; pytest green

## Blocked by

M002, M003.
