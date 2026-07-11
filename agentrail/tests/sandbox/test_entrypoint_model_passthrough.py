"""Hermetic test (AC4) — the runner entrypoint forwards the escalation model +
failure handoff into the in-container ``agentrail run issue``.

This NEVER builds or runs the real image. It drives ``agentrail/docker/runner/entrypoint.sh``
directly under bash with stub ``git`` / ``agentrail`` binaries on PATH that record
the exact argv + environment they were invoked with. We then assert:

- ``AGENTRAIL_MODEL`` is forwarded to ``agentrail run issue`` as ``--model <m>``;
- ``AGENTRAIL_FAILURE_HANDOFF`` is left in the environment (the spine reads it from
  there in the execute phase — it is NOT a CLI flag);
- with neither set, no ``--model`` flag is added (a plain first cheap attempt).

The test is skipped when bash is unavailable.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ENTRYPOINT = _REPO_ROOT / "agentrail" / "docker" / "runner" / "entrypoint.sh"

_SKIP = None
if shutil.which("bash") is None:
    _SKIP = "bash not available"
elif not _ENTRYPOINT.exists():
    _SKIP = f"entrypoint not found at {_ENTRYPOINT}"


@unittest.skipIf(_SKIP is not None, _SKIP or "")
class EntrypointModelPassthroughTest(unittest.TestCase):
    def _run_entrypoint(self, *, env_extra: dict) -> dict:
        """Run the entrypoint with stub git/agentrail and capture their calls.

        Returns the parsed ``agentrail`` invocation record (argv + a snapshot of
        whether the handoff env was visible to it).
        """
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bindir = tmp_path / "bin"
            bindir.mkdir()
            ws_root = tmp_path / "ws"
            ws_root.mkdir()
            argv_log = tmp_path / "agentrail-argv.txt"
            handoff_log = tmp_path / "agentrail-handoff.txt"

            # Stub `git`: succeed on everything (clone / checkout / rev-parse).
            (bindir / "git").write_text(
                "#!/usr/bin/env bash\n"
                'if [ "$1" = "rev-parse" ]; then echo "afk/stub"; fi\n'
                # `git clone <url> /workspace/repo` must create the dir we cd into.
                'if [ "$1" = "clone" ]; then mkdir -p \"${@: -1}\"; fi\n'
                "exit 0\n"
            )
            # Stub `agentrail`: record argv + whether the handoff env is present.
            (bindir / "agentrail").write_text(
                "#!/usr/bin/env bash\n"
                f'printf "%s\\n" "$@" > "{argv_log}"\n'
                f'printf "%s" "${{AGENTRAIL_FAILURE_HANDOFF:-}}" > "{handoff_log}"\n'
                "exit 0\n"
            )
            for f in ("git", "agentrail"):
                os.chmod(bindir / f, 0o755)

            env = dict(os.environ)
            env["PATH"] = f"{bindir}:{env['PATH']}"
            env["AGENTRAIL_WORKSPACE_ROOT"] = str(ws_root)
            env.update(env_extra)

            proc = subprocess.run(
                ["bash", str(_ENTRYPOINT),
                 "https://github.com/acme/widgets.git", "main", "7"],
                env=env, capture_output=True, text=True, timeout=60,
                cwd=tmp,
            )
            argv = argv_log.read_text().splitlines() if argv_log.exists() else []
            handoff_seen = handoff_log.read_text() if handoff_log.exists() else ""
            return {"argv": argv, "handoff_seen": handoff_seen, "proc": proc}

    def test_model_env_becomes_model_flag(self) -> None:
        out = self._run_entrypoint(env_extra={"AGENTRAIL_MODEL": "claude-opus-4-8"})
        argv = out["argv"]
        self.assertIn("run", argv)
        self.assertIn("issue", argv)
        self.assertIn("--model", argv, f"argv was {argv}")
        self.assertEqual(argv[argv.index("--model") + 1], "claude-opus-4-8")

    def test_handoff_env_visible_to_agentrail_run(self) -> None:
        handoff = "## Escalation\n### Goal\nadd widget\n### Exact gate error\nAC2"
        out = self._run_entrypoint(env_extra={"AGENTRAIL_FAILURE_HANDOFF": handoff})
        # The handoff is NOT a flag; it is inherited as env by `agentrail run`.
        self.assertEqual(out["handoff_seen"], handoff)
        self.assertNotIn("--model", out["argv"])

    def test_no_model_no_flag(self) -> None:
        out = self._run_entrypoint(env_extra={})
        self.assertNotIn("--model", out["argv"], f"argv was {out['argv']}")


if __name__ == "__main__":
    unittest.main()
