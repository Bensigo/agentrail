"""
Shared template-sync engine for ``agentrail install`` and ``agentrail upgrade``.

This module is the single source of truth for:

- The managed-file inventory (``templates/`` + ``skills/`` roots, the
  ``scripts/agentrail`` extra file, the hidden ``scripts/`` prefix and the
  skip-patterns).
- Content-hash helpers (``_sha256_file``, ``_walk_files_sorted``, ``_copy_file``).
- The per-item categorize/copy logic (``_categorize_item`` / ``_process_item``)
  shared between a fresh install (``previous=None`` for every item) and an
  upgrade (``previous`` looked up from the prior state).
- The default ``config.json`` / ``workflow`` literals.
- ``.agentrail/source`` materialization — the #404 Option B vendor trim: only
  the native package (``agentrail/``), the ``package.json`` the launcher's
  redirect needs, and the ``templates/`` + ``skills/`` the CLI reads at runtime
  are vendored. NO editable flow scripts (no ``scripts/agentrail`` /
  ``scripts/install-workflow``) are copied into the vendor dir, so installed
  projects cannot fork orchestration.

``upgrade.py`` and ``install.py`` both import from here; behavior is identical
between the two except install drives every item with ``previous=None``.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# The #404 Option B vendor contract.
#
# These are the ONLY directories/files copied into ``.agentrail/source``. The
# launcher (``scripts/agentrail`` on the project surface) resolves the package
# via the ``.agentrail/source/package.json`` redirect, so the vendor must carry
# the native package + the data dirs the CLI reads at runtime, but NOT a copy of
# the editable flow scripts.
# ---------------------------------------------------------------------------

VENDOR_DIRS = ("agentrail", "templates", "skills")
VENDOR_FILES = ("package.json",)

# Editable flow scripts that must NEVER land on the project surface or in the
# vendor dir (asserted by scripts/test-install and tests).
FORBIDDEN_FLOW_SCRIPTS = (
    "ralph-loop",
    "review-pr",
    "afk-workflow",
    "pr",
    "memory",
    "install-workflow",
    "lib/timeout.sh",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sha256_file(path: Path) -> str:
    import hashlib
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def _walk_files_sorted(root: Path) -> List[Path]:
    """Recursively walk directory, returning sorted list of files (not dirs)."""
    results: List[Path] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.is_dir():
            results.extend(_walk_files_sorted(entry))
        elif entry.is_file():
            results.append(entry)
    return results


def _copy_file(source: Path, dest: Path) -> None:
    """Copy source to dest, preserving mode bits (executables stay executable)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    mode = source.stat().st_mode & 0o777
    os.chmod(dest, mode)


# ---------------------------------------------------------------------------
# Skip patterns (exact from legacy)
# ---------------------------------------------------------------------------

_SKIP_PATTERNS = [
    re.compile(r"^TASTE\.md$"),
    re.compile(r"^docs[/\\]memory[/\\]"),
    re.compile(r"^docs[/\\]prd[/\\]context-engine\.md$"),
    re.compile(r"^\.claude[/\\]agents[/\\]"),
    re.compile(r"^\.codex[/\\]agents[/\\]"),
]

_HIDDEN_TEMPLATE_PREFIX = "scripts" + os.sep  # "scripts/" on unix


def _should_skip(relative_to_root: str) -> bool:
    return any(pat.search(relative_to_root) for pat in _SKIP_PATTERNS)


# ---------------------------------------------------------------------------
# Default config / workflow literals (VERBATIM from legacy lines ~370-464)
# ---------------------------------------------------------------------------

DEFAULT_WORKFLOW: Dict[str, Any] = {
    "phase": "idle",
    "activePhase": None,
    "activeIssue": None,
    "activePullRequest": None,
    "activePrd": None,
    "activeMilestone": None,
    "activeRun": None,
    "completedRuns": [],
    "goals": [],
    "worktrees": [],
    "lastCompletedStep": None,
    "nextSuggestedAction": "Pick a ready-for-agent issue or create a PRD/milestone before starting implementation.",
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "schemaVersion": 1,
    "runner": {
        "name": "codex",
        "command": "codex exec --sandbox danger-full-access -",
    },
    "context": {
        "includeGlobs": ["**/*"],
        "excludeGlobs": [
            ".git/**",
            "node_modules/**",
            "dist/**",
            "build/**",
            ".next/**",
            "target/**",
            "coverage/**",
            ".cache/**",
            ".turbo/**",
            ".agentrail/context/**",
            ".agentrail/source/**",
            ".env",
            ".env.*",
            "**/.env",
            "**/.env.*",
            "**/*.pem",
            "**/*.key",
            "**/*credentials*",
            "**/*secret*",
        ],
        "maxFileSizeBytes": 262144,
        "skipBinary": True,
        "respectGitIgnore": True,
        "secretRedaction": {
            "enabled": True,
            "action": "exclude",
            "denyGlobs": [
                ".env",
                ".env.*",
                "**/.env",
                "**/.env.*",
                "**/*.pem",
                "**/*.key",
                "**/*credentials*",
                "**/*secret*",
            ],
        },
        "embedding": {
            "mode": "disabled",
            "provider": None,
            "model": None,
        },
        "summary": {
            "mode": "disabled",
            "provider": None,
            "model": None,
        },
        "externalSources": [],
    },
}


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

def _build_inventory(repo_dir: Path) -> List[Dict[str, Any]]:
    """Build the managed file inventory (templates + skills roots + extraFiles)."""
    roots = [
        (repo_dir / "templates", ""),
        (repo_dir / "skills", "skills"),
    ]
    inventory: List[Dict[str, Any]] = []

    for root, prefix in roots:
        if not root.is_dir():
            continue
        for source_path in _walk_files_sorted(root):
            relative_to_root = source_path.relative_to(root)
            relative_to_root_str = str(relative_to_root)  # os-native separators

            if not prefix:
                # hidden: anything under scripts/
                if relative_to_root_str.startswith(_HIDDEN_TEMPLATE_PREFIX):
                    continue
                # skip patterns use the os-native string (legacy uses relativeToRoot directly)
                if _should_skip(relative_to_root_str):
                    continue

            # managedPath: prefix joined with relativeToRoot, converted to posix
            if prefix:
                managed_path = (Path(prefix) / relative_to_root).as_posix()
            else:
                managed_path = relative_to_root.as_posix()

            source_posix = source_path.relative_to(repo_dir).as_posix()

            inventory.append({
                "path": managed_path,
                "source": source_posix,
                "sourcePath": source_path,
                "sourceHash": _sha256_file(source_path),
            })

    # extraFiles
    extra_source = repo_dir / "scripts" / "agentrail"
    inventory.append({
        "path": "scripts/agentrail",
        "source": extra_source.relative_to(repo_dir).as_posix(),
        "sourcePath": extra_source,
        "sourceHash": _sha256_file(extra_source),
    })

    return inventory


def _categorize_item(
    item: Dict[str, Any],
    previous: Optional[Dict[str, Any]],
    legacy_adopted_state: bool,
    force: bool,
    target_dir: Path,
    *,
    install_mode: bool = False,
) -> tuple:
    """
    Returns (category, install_status, should_copy).

    Two regimes:

    * ``install_mode=False`` (the *upgrade* path): hash-diff categorization,
      faithfully reproducing the legacy upgrade JS (lines ~302-368).
    * ``install_mode=True`` (the *install* path): reproduces the legacy bash
      ``scripts/install-workflow`` exactly — a file's status is driven purely by
      whether it existed before this install and whether a prior state.json was
      present, NOT by hash diffs:

        - existed before + prior state  -> "updated" (force) else "preserved"
        - existed before + no state     -> "updated" (force) else "legacy-adopted"
        - did not exist before          -> "installed"

      and the file is copied iff it did not exist or ``--force`` is set (bash
      ``copy_file``: ``cp`` unless ``-e dest && !force``).
    """
    target_path = target_dir / item["path"]
    target_exists = target_path.exists()
    current_hash = _sha256_file(target_path) if target_exists else None
    source_hash = item["sourceHash"]

    if install_mode:
        existed_before = target_exists
        has_state = previous is not None
        if not existed_before:
            install_status = "installed"
            category = "added"
        elif has_state:
            install_status = "updated" if force else "preserved"
            category = "changed" if force else "unchanged"
        else:
            install_status = "updated" if force else "legacy-adopted"
            category = "changed" if force else "added"
        should_copy = (not existed_before) or force
        return category, install_status, should_copy

    user_owned = bool(
        previous and (
            previous.get("installStatus") == "legacy-adopted"
            or (previous.get("installStatus") == "preserved" and legacy_adopted_state)
        )
    )

    category = "unchanged"
    install_status = (previous.get("installStatus") if previous else None) or "preserved"
    should_copy = False

    if not previous:
        category = "added"
        if target_exists and current_hash != source_hash and not force:
            install_status = "legacy-adopted"
        else:
            install_status = "added"
        should_copy = (not target_exists) or force or (current_hash == source_hash)
    elif not target_exists:
        category = "missing"
        install_status = "restored"
        should_copy = True
    elif user_owned and source_hash != previous.get("contentHash"):
        category = "locally modified"
        install_status = "forced" if force else "preserved"
        should_copy = force
    elif current_hash != previous.get("contentHash") and current_hash != source_hash:
        category = "locally modified"
        install_status = "forced" if force else "preserved"
        should_copy = force
    elif source_hash != previous.get("contentHash"):
        category = "changed"
        install_status = "updated"
        should_copy = True
    # else: unchanged — keep defaults

    return category, install_status, should_copy


def _process_item(
    item: Dict[str, Any],
    previous: Optional[Dict[str, Any]],
    legacy_adopted_state: bool,
    force: bool,
    target_dir: Path,
    *,
    install_mode: bool = False,
) -> Dict[str, Any]:
    """Process a single inventory item: print, copy if needed, build next managed record."""
    target_path = target_dir / item["path"]
    source_path: Path = item["sourcePath"]

    category, install_status, should_copy = _categorize_item(
        item, previous, legacy_adopted_state, force, target_dir,
        install_mode=install_mode,
    )

    # Print category line (when not unchanged)
    if category != "unchanged":
        print(f"{category}: {item['path']}")

    if should_copy:
        _copy_file(source_path, target_path)
        if install_status == "forced":
            print(f"forced: {item['path']}")
        elif install_status == "restored":
            print(f"restored: {item['path']}")
        elif install_status == "updated":
            print(f"updated: {item['path']}")
        else:
            print(f"installed: {item['path']}")
    elif category == "locally modified":
        print(f"preserved local: {item['path']}")
    elif category == "added":
        print(f"preserved existing untracked: {item['path']}")

    # Compute finalHash
    if category == "locally modified" and not force and previous:
        final_hash = previous.get("contentHash")
    else:
        final_hash = _sha256_file(target_path) if target_path.exists() else item["sourceHash"]

    return {
        "path": item["path"],
        "source": item["source"],
        "contentHash": final_hash,
        "installStatus": install_status,
    }


# ---------------------------------------------------------------------------
# Vendor materialization — #404 Option B trim
# ---------------------------------------------------------------------------

def _materialize_source(repo_dir: Path, target_dir: Path) -> None:
    """
    Materialize the trimmed ``.agentrail/source`` vendor dir.

    #404 Option B: vendor ONLY the native package + the runtime data dirs +
    ``package.json`` (so the launcher's redirect resolves the package). Do NOT
    copy editable flow scripts (``scripts/agentrail``/``install-workflow``) — the
    flow is native inside the vendored ``agentrail/`` package and projects cannot
    fork orchestration.

    Skips entirely when ``target/.agentrail/source`` IS ``repo_dir`` (dogfooding
    guard).
    """
    source_support_dir = target_dir / ".agentrail" / "source"
    source_support_dir.mkdir(parents=True, exist_ok=True)

    try:
        repo_real = repo_dir.resolve()
        source_real = source_support_dir.resolve()
    except OSError:
        repo_real = repo_dir
        source_real = source_support_dir

    if repo_real == source_real:
        return

    # Remove any pre-existing editable flow scripts left by older installers
    # (the legacy bash installer vendored .agentrail/source/scripts/*).
    stale_scripts = source_support_dir / "scripts"
    if stale_scripts.exists():
        shutil.rmtree(stale_scripts)

    # Vendor files (package.json) — needed by the launcher redirect.
    for file_name in VENDOR_FILES:
        src = repo_dir / file_name
        if src.exists():
            shutil.copy2(src, source_support_dir / file_name)

    # Vendor dirs (rm -rf then cp -R) — the native package + runtime data dirs.
    for dir_name in VENDOR_DIRS:
        dst = source_support_dir / dir_name
        if dst.exists():
            shutil.rmtree(dst)
        src = repo_dir / dir_name
        if src.exists():
            shutil.copytree(src, dst)

    print("updated: .agentrail/source")
