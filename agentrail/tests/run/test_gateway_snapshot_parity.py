"""Drift + packaging guards for the gateway catalog snapshot (#1337).

The OpenRouter price snapshot is hand-mirrored into two byte-identical
committed copies (the same #1334/#1335 cross-language drift-guard convention
PRICE_TABLE uses) because the console image and the runner/fleet image have
disjoint file sets — one path cannot serve both:

  - agentrail/context/openrouter-catalog.snapshot.json      (Python reader,
    agentrail/run/pricing.py; ships in the runner image)
  - apps/console/lib/alignment/openrouter-catalog.snapshot.json  (console
    reader, gateway-catalog.ts; ships in the console image)

If these ever diverge, a run's cost metering (Python) and its brief estimate
(console) would price the same model differently — a silent auditability
break. These tests fail CI on that drift, and on the packaging regression
that would make the Python copy silently absent in the deployed runner image.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from agentrail.run.pricing import _GATEWAY_RATES, _SNAPSHOT_PATH

# agentrail/tests/run/test_x.py -> repo root is parents[3].
_REPO_ROOT = Path(__file__).resolve().parents[3]
_CONSOLE_SNAPSHOT = _REPO_ROOT / "apps" / "console" / "lib" / "alignment" / "openrouter-catalog.snapshot.json"
_PACKAGE_SNAPSHOT = _REPO_ROOT / "agentrail" / "context" / "openrouter-catalog.snapshot.json"
_PYPROJECT = _REPO_ROOT / "pyproject.toml"


def test_both_snapshot_copies_exist() -> None:
    assert _PACKAGE_SNAPSHOT.is_file(), f"package-local snapshot missing at {_PACKAGE_SNAPSHOT}"
    assert _CONSOLE_SNAPSHOT.is_file(), f"console snapshot missing at {_CONSOLE_SNAPSHOT}"


def test_gateway_snapshot_parity_byte_identical() -> None:
    """The two committed copies must be byte-for-byte identical (drift guard).

    `refresh-openrouter-catalog.ts` writes the SAME serialized bytes to both;
    this is the CI backstop that catches a refresh which forgot one copy, or a
    hand-edit to just one file.
    """
    package_bytes = _PACKAGE_SNAPSHOT.read_bytes()
    console_bytes = _CONSOLE_SNAPSHOT.read_bytes()
    assert package_bytes == console_bytes, (
        "gateway snapshot copies have DRIFTED — "
        f"{_PACKAGE_SNAPSHOT} and {_CONSOLE_SNAPSHOT} differ. "
        "Re-run `pnpm --filter @agentrail/console catalog:refresh` (it writes both)."
    )


def test_python_reads_the_package_local_copy_not_the_console_copy() -> None:
    """pricing.py's snapshot path must be the package-local file (ships in the
    runner image), NOT the apps/console copy (absent from that image). This is
    the exact FIX for the [Critical] finding: were `_SNAPSHOT_PATH` still under
    apps/console, `_GATEWAY_RATES` would be empty in prod and every gateway-only
    model would silently price at $0."""
    resolved = str(_SNAPSHOT_PATH)
    assert "apps/console" not in resolved, (
        f"_SNAPSHOT_PATH points at the console copy ({resolved}) — it must be the "
        "package-local agentrail/context copy so it ships in the runner image."
    )
    assert _SNAPSHOT_PATH == _PACKAGE_SNAPSHOT
    assert _SNAPSHOT_PATH.is_file()


def test_gateway_rates_loaded_nonempty() -> None:
    """The module actually loaded rates from the package-local copy at import —
    a non-empty table is what makes gateway-first resolution real in prod."""
    assert len(_GATEWAY_RATES) > 0
    # The 3 shipped hosted-fleet seats must be present and priced.
    for slug in ("anthropic/claude-sonnet-5", "z-ai/glm-5.2", "anthropic/claude-haiku-4.5"):
        assert slug in _GATEWAY_RATES, f"{slug} missing from the loaded gateway rates"
        in_rate, out_rate = _GATEWAY_RATES[slug]
        assert in_rate >= 0 and out_rate >= 0


def test_pyproject_ships_the_snapshot_as_package_data() -> None:
    """The packaging config must list the snapshot under package-data so
    `pip install .` (how the runner image installs the package, non-editable)
    includes it in site-packages. Without this line the file exists in the
    source tree but is absent from the installed wheel — the silent-$0 failure
    mode again. A static-text assertion (not tomllib) so it runs on py3.9+.
    """
    pyproject_text = _PYPROJECT.read_text(encoding="utf-8")
    # The package-data value for `agentrail` must reference the snapshot file.
    package_data_match = re.search(
        r"\[tool\.setuptools\.package-data\](.*?)(?:\n\[|\Z)",
        pyproject_text,
        re.DOTALL,
    )
    assert package_data_match, "pyproject.toml has no [tool.setuptools.package-data] section"
    section = package_data_match.group(1)
    assert "context/openrouter-catalog.snapshot.json" in section, (
        "pyproject.toml's package-data no longer lists "
        "context/openrouter-catalog.snapshot.json — the runner image would ship "
        "without the gateway snapshot and price every gateway-only model at $0."
    )
