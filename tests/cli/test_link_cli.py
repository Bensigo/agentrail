"""Unit tests for `agentrail link` CLI command (agentrail/cli/commands/link.py).

All external I/O (urllib.request.urlopen, file system) is patched so these
tests run without a real server.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

from agentrail.cli.commands.link import run_link


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fake_response(status: int, body: dict) -> MagicMock:
    """Simulate a successful urllib response (status 200)."""
    m = MagicMock()
    m.status = status
    m.read.return_value = json.dumps(body).encode()
    m.__enter__ = lambda s: s
    m.__exit__ = MagicMock(return_value=False)
    return m


def _http_error(code: int, body: dict) -> urllib.error.HTTPError:
    msg = json.dumps(body).encode()
    err = urllib.error.HTTPError(
        url="http://test",
        code=code,
        msg=str(code),
        hdrs=None,  # type: ignore[arg-type]
        fp=BytesIO(msg),
    )
    return err


SUCCESS_BODY = {
    "workspace": {"id": "ws-1", "name": "My Workspace", "slug": "my-workspace"},
    "repository": {"id": "repo-1", "name": "my-repo"},
}

BASE_ARGS = [
    "--workspace", "ws-1",
    "--repo", "repo-1",
    "--key", "ar_" + "a" * 64,
]


# ---------------------------------------------------------------------------
# AC1: Success writes config
# ---------------------------------------------------------------------------

class LinkSuccessTests(unittest.TestCase):
    def test_success_writes_server_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    return_value=_fake_response(200, SUCCESS_BODY),
                ):
                    rc = run_link(BASE_ARGS)

            self.assertEqual(rc, 0)
            config_path = Path(tmpdir) / ".agentrail" / "server.json"
            self.assertTrue(config_path.exists(), "server.json not written")
            config = json.loads(config_path.read_text())
            self.assertEqual(config["workspace_id"], "ws-1")
            self.assertEqual(config["repository_id"], "repo-1")
            self.assertIn("base_url", config)
            self.assertIn("api_key", config)

    def test_success_default_base_url(self) -> None:
        # Default is env-driven; with AGENTRAIL_BASE_URL unset it falls back to localhost.
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch(
                "agentrail.cli.commands.link.DEFAULT_BASE_URL", "http://localhost:3000"
            ):
                with patch(
                    "agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)
                ):
                    with patch(
                        "agentrail.cli.commands.link.urllib.request.urlopen",
                        return_value=_fake_response(200, SUCCESS_BODY),
                    ) as mock_open:
                        run_link(BASE_ARGS)
            req = mock_open.call_args[0][0]
            self.assertIn("localhost:3000", req.full_url)

    def test_default_base_url_reads_env(self) -> None:
        # AGENTRAIL_BASE_URL drives DEFAULT_BASE_URL (no hardcoded production host).
        import os
        import importlib
        import agentrail.cli.commands.link as link_mod

        try:
            with patch.dict(
                os.environ, {"AGENTRAIL_BASE_URL": "https://console.example.com"}
            ):
                importlib.reload(link_mod)
                self.assertEqual(
                    link_mod.DEFAULT_BASE_URL, "https://console.example.com"
                )
        finally:
            importlib.reload(link_mod)  # restore default for other tests

    def test_success_custom_base_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    return_value=_fake_response(200, SUCCESS_BODY),
                ) as mock_open:
                    run_link(BASE_ARGS + ["--base-url", "http://localhost:3000"])
            req = mock_open.call_args[0][0]
            self.assertIn("localhost:3000", req.full_url)

    def test_bearer_header_sent(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    return_value=_fake_response(200, SUCCESS_BODY),
                ) as mock_open:
                    run_link(BASE_ARGS)
            req = mock_open.call_args[0][0]
            auth = req.get_header("Authorization")
            self.assertTrue(auth.startswith("Bearer ar_"), auth)


# ---------------------------------------------------------------------------
# AC2: Server error exit
# ---------------------------------------------------------------------------

class LinkServerErrorTests(unittest.TestCase):
    def test_http_error_exits_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    side_effect=_http_error(401, {"error": "Invalid API key"}),
                ):
                    rc = run_link(BASE_ARGS)
            self.assertEqual(rc, 1)

    def test_http_error_prints_status_and_message(self) -> None:
        stderr_output: list[str] = []

        def fake_print(*args: object, **kwargs: object) -> None:
            if kwargs.get("file") is sys.stderr:
                stderr_output.append(" ".join(str(a) for a in args))

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    side_effect=_http_error(401, {"error": "Invalid API key"}),
                ):
                    with patch("builtins.print", side_effect=fake_print):
                        run_link(BASE_ARGS)

        self.assertTrue(
            any("401" in line for line in stderr_output),
            f"Expected 401 in stderr: {stderr_output}",
        )
        self.assertTrue(
            any("Invalid API key" in line for line in stderr_output),
            f"Expected error message in stderr: {stderr_output}",
        )

    def test_http_error_does_not_write_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    side_effect=_http_error(403, {"error": "Forbidden"}),
                ):
                    run_link(BASE_ARGS)
            config_path = Path(tmpdir) / ".agentrail" / "server.json"
            self.assertFalse(config_path.exists(), "server.json should not be written on error")


# ---------------------------------------------------------------------------
# AC3: --force overwrite / refusal without --force
# ---------------------------------------------------------------------------

class LinkForceTests(unittest.TestCase):
    def _write_existing(self, tmpdir: str) -> None:
        agentrail_dir = Path(tmpdir) / ".agentrail"
        agentrail_dir.mkdir(parents=True, exist_ok=True)
        (agentrail_dir / "server.json").write_text(
            json.dumps(
                {
                    "base_url": "https://app.agentrail.dev",
                    "workspace_id": "old-ws",
                    "repository_id": "old-repo",
                    "api_key": "ar_old",
                }
            )
        )

    def test_refuses_to_overwrite_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            self._write_existing(tmpdir)
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                rc = run_link(BASE_ARGS)
            self.assertEqual(rc, 1)

    def test_refusal_message_names_existing_workspace_repo(self) -> None:
        stderr_output: list[str] = []

        def fake_print(*args: object, **kwargs: object) -> None:
            if kwargs.get("file") is sys.stderr:
                stderr_output.append(" ".join(str(a) for a in args))

        with tempfile.TemporaryDirectory() as tmpdir:
            self._write_existing(tmpdir)
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch("builtins.print", side_effect=fake_print):
                    run_link(BASE_ARGS)

        combined = " ".join(stderr_output)
        self.assertIn("old-ws", combined)
        self.assertIn("old-repo", combined)

    def test_force_overwrites_existing_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            self._write_existing(tmpdir)
            with patch("agentrail.cli.commands.link.Path.cwd", return_value=Path(tmpdir)):
                with patch(
                    "agentrail.cli.commands.link.urllib.request.urlopen",
                    return_value=_fake_response(200, SUCCESS_BODY),
                ):
                    rc = run_link(BASE_ARGS + ["--force"])
            self.assertEqual(rc, 0)
            config = json.loads(
                (Path(tmpdir) / ".agentrail" / "server.json").read_text()
            )
            self.assertEqual(config["workspace_id"], "ws-1")
            self.assertEqual(config["repository_id"], "repo-1")


# ---------------------------------------------------------------------------
# Missing arguments
# ---------------------------------------------------------------------------

class LinkMissingArgsTests(unittest.TestCase):
    def test_missing_workspace_exits_nonzero(self) -> None:
        rc = run_link(["--repo", "repo-1", "--key", "ar_" + "a" * 64])
        self.assertEqual(rc, 1)

    def test_missing_repo_exits_nonzero(self) -> None:
        rc = run_link(["--workspace", "ws-1", "--key", "ar_" + "a" * 64])
        self.assertEqual(rc, 1)

    def test_missing_key_exits_nonzero(self) -> None:
        rc = run_link(["--workspace", "ws-1", "--repo", "repo-1"])
        self.assertEqual(rc, 1)

    def test_help_exits_zero(self) -> None:
        for flag in ("-h", "--help"):
            with self.subTest(flag=flag):
                rc = run_link([flag])
                self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
# Task 4: auto-index after successful link
# ---------------------------------------------------------------------------

from unittest.mock import patch as _patch

import agentrail.cli.commands.link as link_mod


def test_link_auto_indexes_on_success(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with _patch.object(link_mod, "_post_link", return_value={"workspace": {"name": "W"}, "repository": {"name": "R"}}), \
         _patch.object(link_mod, "build_index", return_value={"commitSha": "x", "indexed": 1, "graphEdges": 2}) as bi, \
         _patch.object(link_mod, "push_index_snapshot", return_value=True) as push:
        rc = link_mod.run_link([
            "--workspace", "ws", "--repo", "repo", "--key", "ar_k",
            "--base-url", "http://localhost:3000",
        ])
    assert rc == 0
    bi.assert_called_once()
    push.assert_called_once()


def test_link_no_index_flag_skips_indexing(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with _patch.object(link_mod, "_post_link", return_value={"workspace": {"name": "W"}, "repository": {"name": "R"}}), \
         _patch.object(link_mod, "build_index") as bi:
        rc = link_mod.run_link([
            "--workspace", "ws", "--repo", "repo", "--key", "ar_k",
            "--base-url", "http://localhost:3000", "--no-index",
        ])
    assert rc == 0
    bi.assert_not_called()


if __name__ == "__main__":
    unittest.main()
