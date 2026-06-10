from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List


@dataclass(frozen=True)
class WalkedFile:
    full_path: Path
    relative_path: str
    directory: bool = False
    skip_reason: str | None = None


def to_posix(path: str | Path) -> str:
    return str(path).replace(os.sep, "/")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def escape_regex(value: str) -> str:
    return re.escape(value)


def glob_to_regex(glob: str) -> re.Pattern[str]:
    regex = ""
    index = 0
    while index < len(glob):
      char = glob[index]
      next_char = glob[index + 1] if index + 1 < len(glob) else ""
      third_char = glob[index + 2] if index + 2 < len(glob) else ""
      if char == "*" and next_char == "*" and third_char == "/":
          regex += r"(?:.*/)?"
          index += 3
      elif char == "*" and next_char == "*":
          regex += ".*"
          index += 2
      elif char == "*":
          regex += r"[^/]*"
          index += 1
      elif char == "?":
          regex += r"[^/]"
          index += 1
      else:
          regex += escape_regex(char)
          index += 1
    return re.compile(f"^{regex}$", re.IGNORECASE)


_GLOB_CACHE: dict[str, re.Pattern[str]] = {}


def matches_glob(glob: str, relative_path: str, is_directory: bool = False) -> bool:
    if glob == "**/*":
        return True
    if glob.endswith("/**") and "*" not in glob[:-3] and "?" not in glob[:-3]:
        # Fast path for a literal anchored prefix like "node_modules/**". Only
        # valid when the prefix has no glob metachars; patterns such as
        # "**/node_modules/**" fall through to the regex below so they match at
        # any depth.
        prefix = glob[:-3]
        return relative_path == prefix or relative_path.startswith(f"{prefix}/")
    if glob.startswith("**/"):
        suffix = glob[3:]
        suffix_regex = glob_to_regex(suffix)
        inner = suffix_regex.pattern[1:-1]
        if re.match(f"^(?:.*/)?{inner}$", relative_path, re.IGNORECASE):
            return True
    target = f"{relative_path}/" if is_directory else relative_path
    pattern = _GLOB_CACHE.setdefault(glob, glob_to_regex(glob))
    return bool(pattern.match(relative_path) or pattern.match(target))


def matches_any(globs: Iterable[str], relative_path: str, is_directory: bool = False) -> bool:
    return any(matches_glob(glob, relative_path, is_directory) for glob in globs)


def walk_files(root: Path, exclude_globs: Iterable[str], *, include_skipped_dirs: bool = False) -> List[WalkedFile]:
    results: List[WalkedFile] = []
    exclude_list = list(exclude_globs)

    def walk(directory: Path) -> None:
        try:
            entries = sorted(directory.iterdir(), key=lambda item: item.name)
        except OSError:
            return
        for entry in entries:
            rel = to_posix(entry.relative_to(root))
            if entry.is_dir():
                if entry.is_symlink():
                    # Never descend into symlinked directories. pnpm/yarn
                    # workspaces expose dependency trees as symlinked
                    # node_modules; following them pulls tens of thousands of
                    # files into the index and risks symlink cycles.
                    if include_skipped_dirs:
                        results.append(WalkedFile(entry, rel, True, "symlink"))
                elif matches_any(exclude_list, rel, True):
                    if include_skipped_dirs:
                        results.append(WalkedFile(entry, rel, True, "exclude_glob"))
                else:
                    walk(entry)
            elif entry.is_file():
                results.append(WalkedFile(entry, rel))

    walk(root)
    return results


def is_binary_file(path: Path) -> bool:
    with path.open("rb") as file:
        return b"\0" in file.read(8192)
