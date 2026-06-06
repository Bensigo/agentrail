from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Iterable, Optional, Set


def git_ignored_set(root: Path, paths: Iterable[str], respect_git_ignore: bool) -> Set[str]:
    path_list = list(paths)
    if not respect_git_ignore or not path_list:
        return set()
    try:
        subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        return set()
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--stdin"],
        input="\n".join(path_list),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return {line for line in result.stdout.splitlines() if line}


def current_commit_sha(root: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except subprocess.CalledProcessError:
        return None
    value = result.stdout.strip()
    return value or None
