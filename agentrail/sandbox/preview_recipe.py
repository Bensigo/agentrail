"""Pure-Python recipe detector for booting a cloned repo in a preview sandbox
(B2b "boot plane").

``detect_recipe`` figures out how to bring a freshly cloned repo up for a
preview: an install command, a start command, a port, and a path to poll for
readiness. It only READS real files already in the checkout — it never runs a
command, never shells out, and never raises (any unreadable/malformed input
degrades to "try the next detection step", and ultimately to ``None``).

This sits beside :func:`agentrail.runner.onboard._detect_command_hints`, which
does a coarse string-match over a text digest to produce human-readable
*hints* for onboarding notes. This module instead reads the actual manifest
files and produces argv *commands* a caller can execute directly.

Detection order:
  1. An explicit flat ``preview`` key in ``.agentrail/config.json``::

         {"preview": {"install": "npm ci", "start": "npm run dev",
                       "port": 3000, "readyPath": "/"}}

     ``install``/``start`` are shell command strings, split with
     :func:`shlex.split`. ``start`` and ``port`` are required; ``install``
     (``None`` skips the install step) and ``readyPath`` (defaults to ``"/"``)
     are optional. Reading a missing/malformed config.json, or the ``preview``
     block being absent or missing a required field, is treated as "no
     explicit config" and falls through to step 2 — this step never raises.
  2. ``package.json`` heuristics:
       - start: ``scripts.dev`` -> ``["npm", "run", "dev"]``, else
         ``scripts.start`` -> ``["npm", "run", "start"]``; neither present
         means undetectable.
       - install: ``["npm", "ci"]`` if ``package-lock.json`` exists next to
         it, else ``["npm", "install"]``.
       - port: 3000 if ``next`` is a (dev)dependency, 5173 if ``vite`` is,
         3000 if ``react-scripts`` is, else 3000.
  3. Nothing usable was found -> ``None``.
"""
from __future__ import annotations

import json
import os
import shlex
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PreviewRecipe:
    install: list[str] | None  # argv, e.g. ["npm", "ci"]; None = skip install
    start: list[str]  # argv for the dev server
    port: int
    ready_path: str = "/"  # GET path that returns 2xx/3xx when up


# (dependency name, port) — first match wins; order matters (next before the
# else-default of 3000 is a no-op, but is kept explicit per the detection
# order this module documents).
_PORT_BY_DEPENDENCY: tuple[tuple[str, int], ...] = (
    ("next", 3000),
    ("vite", 5173),
    ("react-scripts", 3000),
)
_DEFAULT_PORT = 3000


def detect_recipe(repo_dir: str) -> PreviewRecipe | None:
    """Best-effort :class:`PreviewRecipe` for the repo at ``repo_dir``.

    Returns ``None`` when nothing usable is found. Never raises: any I/O or
    parse error on either candidate file is treated as "not present".
    """
    explicit = _from_explicit_config(repo_dir)
    if explicit is not None:
        return explicit
    return _from_package_json(repo_dir)


def _load_json_object(path: str) -> dict[str, Any] | None:
    """Read+parse ``path`` as a JSON object, or ``None`` on any problem."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _split_command(value: Any) -> list[str] | None:
    """Shell-split a command string, or ``None`` if unusable."""
    if not isinstance(value, str) or not value.strip():
        return None
    return shlex.split(value)


def _from_explicit_config(repo_dir: str) -> PreviewRecipe | None:
    """The flat ``preview`` key in ``.agentrail/config.json``, if complete."""
    config = _load_json_object(os.path.join(repo_dir, ".agentrail", "config.json"))
    if config is None:
        return None

    preview = config.get("preview")
    if not isinstance(preview, dict):
        return None

    start = _split_command(preview.get("start"))
    if start is None:
        return None

    port = preview.get("port")
    if not isinstance(port, int) or isinstance(port, bool):
        return None

    install_raw = preview.get("install")
    install = _split_command(install_raw) if install_raw is not None else None

    ready_path = preview.get("readyPath", "/")
    if not isinstance(ready_path, str) or not ready_path:
        ready_path = "/"

    return PreviewRecipe(install=install, start=start, port=port, ready_path=ready_path)


def _from_package_json(repo_dir: str) -> PreviewRecipe | None:
    """``npm``-flavored heuristics derived from ``package.json``."""
    pkg = _load_json_object(os.path.join(repo_dir, "package.json"))
    if pkg is None:
        return None

    scripts = pkg.get("scripts")
    scripts = scripts if isinstance(scripts, dict) else {}
    if scripts.get("dev"):
        start = ["npm", "run", "dev"]
    elif scripts.get("start"):
        start = ["npm", "run", "start"]
    else:
        return None

    has_lockfile = os.path.isfile(os.path.join(repo_dir, "package-lock.json"))
    install = ["npm", "ci"] if has_lockfile else ["npm", "install"]

    deps: dict[str, Any] = {}
    for key in ("dependencies", "devDependencies"):
        section = pkg.get(key)
        if isinstance(section, dict):
            deps.update(section)

    port = _DEFAULT_PORT
    for dep_name, dep_port in _PORT_BY_DEPENDENCY:
        if dep_name in deps:
            port = dep_port
            break

    return PreviewRecipe(install=install, start=start, port=port, ready_path="/")
