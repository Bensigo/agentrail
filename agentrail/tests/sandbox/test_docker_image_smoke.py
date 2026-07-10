"""SMOKE TEST (AC3) — builds the real runner image and runs a trivial command.

This is the ONLY test in this suite that touches a real Docker daemon. It is
SKIPPED gracefully when Docker is unavailable (e.g. CI without a daemon) so the
hermetic suite always runs. It does NOT require any agent API key — it only
proves the image builds and that git/python/node and the agentrail CLI are
present and runnable inside it.

Run explicitly with:  AGENTRAIL_DOCKER_SMOKE=1 python -m unittest \
    agentrail.tests.sandbox.test_docker_image_smoke
"""
from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_DOCKERFILE = _REPO_ROOT / "agentrail" / "docker" / "runner" / "Dockerfile"
_IMAGE_TAG = "agentrail/runner:smoke"


def _docker_available() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        proc = subprocess.run(
            ["docker", "info"], capture_output=True, text=True, timeout=20
        )
        return proc.returncode == 0
    except Exception:
        return False


# Building an image is slow; gate it behind an explicit opt-in OR a reachable
# daemon. Either way, skip cleanly so CI without Docker stays green.
_SKIP_REASON = None
if not _DOCKERFILE.exists():
    _SKIP_REASON = f"Dockerfile not found at {_DOCKERFILE}"
elif not _docker_available():
    _SKIP_REASON = "Docker daemon not available"


@unittest.skipIf(_SKIP_REASON is not None, _SKIP_REASON or "")
class DockerImageSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        build = subprocess.run(
            ["docker", "build", "-f", str(_DOCKERFILE), "-t", _IMAGE_TAG, str(_REPO_ROOT)],
            capture_output=True, text=True, timeout=1200,
        )
        if build.returncode != 0:
            raise AssertionError(
                "image build failed:\n" + build.stdout[-4000:] + "\n" + build.stderr[-4000:]
            )

    def _run_in_image(self, *cmd: str) -> subprocess.CompletedProcess:
        # Override the entrypoint: the image's default entrypoint expects
        # <repo_url> <ref> <issue_ref>; for these trivial liveness checks we run
        # a bare binary instead.
        return subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", cmd[0], _IMAGE_TAG, *cmd[1:]],
            capture_output=True, text=True, timeout=120,
        )

    def test_trivial_command_runs(self) -> None:
        proc = self._run_in_image("echo", "hello-from-sandbox")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("hello-from-sandbox", proc.stdout)

    def test_git_present(self) -> None:
        proc = self._run_in_image("git", "--version")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("git version", proc.stdout)

    def test_python_present(self) -> None:
        proc = self._run_in_image("python3", "--version")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_node_present(self) -> None:
        proc = self._run_in_image("node", "--version")
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_agentrail_cli_importable(self) -> None:
        # The CLI must be installed and runnable (no agent key required).
        proc = self._run_in_image("agentrail", "--help")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    if os.environ.get("AGENTRAIL_DOCKER_SMOKE") != "1" and _SKIP_REASON is None:
        print("Set AGENTRAIL_DOCKER_SMOKE=1 to run the slow image build smoke test.")
    unittest.main()
