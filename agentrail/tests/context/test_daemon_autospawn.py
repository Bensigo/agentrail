"""Tests for context.daemonAutoSpawn config flag (issue #594).

AC coverage:
  AC1  daemonAutoSpawn=true + socket absent → start_detached called once.
  AC2  spawning is non-blocking and produces no user-visible output.
  AC4  daemonAutoSpawn=false (default) → start_detached NOT called.
  AC4  daemonAutoSpawn absent (default) → start_detached NOT called.
       spawn exception swallowed → still returns _ColdClient, no stderr.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agentrail.context.client import _ColdClient, _resolve_context_client


def _write_config(target: Path, daemon_auto_spawn: bool) -> None:
    agentrail_dir = target / ".agentrail"
    agentrail_dir.mkdir(parents=True, exist_ok=True)
    config = {"context": {"daemonAutoSpawn": daemon_auto_spawn}}
    (agentrail_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")


class TestAutoSpawnFlagTrue(unittest.TestCase):
    """When daemonAutoSpawn=true and socket is absent, start_detached is called."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        _write_config(self._tmp, daemon_auto_spawn=True)

    def test_start_detached_called_once_when_flag_true(self) -> None:
        with mock.patch("agentrail.context.client._daemon_mod.start_detached") as m_spawn:
            client = _resolve_context_client(self._tmp)
        m_spawn.assert_called_once_with(self._tmp)
        self.assertIsInstance(client, _ColdClient)

    def test_returns_cold_client_immediately(self) -> None:
        with mock.patch("agentrail.context.client._daemon_mod.start_detached"):
            client = _resolve_context_client(self._tmp)
        self.assertIsInstance(client, _ColdClient)
        self.assertEqual(client.mode, "cold")

    def test_no_stdout_or_stderr_on_autospawn(self) -> None:
        buf_out = io.StringIO()
        buf_err = io.StringIO()
        with mock.patch("agentrail.context.client._daemon_mod.start_detached"):
            with mock.patch("sys.stdout", buf_out), mock.patch("sys.stderr", buf_err):
                _resolve_context_client(self._tmp)
        self.assertEqual(buf_out.getvalue(), "", "unexpected stdout on auto-spawn")
        self.assertEqual(buf_err.getvalue(), "", "unexpected stderr on auto-spawn")


class TestAutoSpawnFlagFalse(unittest.TestCase):
    """When daemonAutoSpawn=false, start_detached must NOT be called."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        _write_config(self._tmp, daemon_auto_spawn=False)

    def test_start_detached_not_called_when_flag_false(self) -> None:
        with mock.patch("agentrail.context.client._daemon_mod.start_detached") as m_spawn:
            client = _resolve_context_client(self._tmp)
        m_spawn.assert_not_called()
        self.assertIsInstance(client, _ColdClient)


class TestAutoSpawnFlagAbsent(unittest.TestCase):
    """When daemonAutoSpawn is absent (no config), default is false → no spawn."""

    def setUp(self) -> None:
        # No .agentrail/config.json written → pure default
        self._tmp = Path(tempfile.mkdtemp()).resolve()

    def test_start_detached_not_called_when_no_config(self) -> None:
        with mock.patch("agentrail.context.client._daemon_mod.start_detached") as m_spawn:
            client = _resolve_context_client(self._tmp)
        m_spawn.assert_not_called()
        self.assertIsInstance(client, _ColdClient)


class TestAutoSpawnExceptionSwallowed(unittest.TestCase):
    """If start_detached raises, the exception is swallowed and _ColdClient returned."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        _write_config(self._tmp, daemon_auto_spawn=True)

    def test_spawn_exception_swallowed(self) -> None:
        with mock.patch(
            "agentrail.context.client._daemon_mod.start_detached",
            side_effect=OSError("spawn failed"),
        ):
            try:
                client = _resolve_context_client(self._tmp)
            except Exception as exc:
                self.fail(f"_resolve_context_client raised unexpectedly: {exc}")
        self.assertIsInstance(client, _ColdClient)

    def test_no_stderr_when_spawn_raises(self) -> None:
        buf_err = io.StringIO()
        with mock.patch(
            "agentrail.context.client._daemon_mod.start_detached",
            side_effect=OSError("spawn failed"),
        ):
            with mock.patch("sys.stderr", buf_err):
                _resolve_context_client(self._tmp)
        self.assertEqual(buf_err.getvalue(), "")


class TestAutoSpawnWhenPingFails(unittest.TestCase):
    """Socket exists but ping fails (cold fallback) → start_detached called if flag=true."""

    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp()).resolve()
        _write_config(self._tmp, daemon_auto_spawn=True)

    def test_start_detached_called_when_socket_exists_but_ping_fails(self) -> None:
        # Patch socket_path_for to return a path that "exists", then rpc raises.
        fake_sock = self._tmp / "fake.sock"
        fake_sock.touch()
        with mock.patch(
            "agentrail.context.client._daemon_mod.socket_path_for",
            return_value=fake_sock,
        ), mock.patch(
            "agentrail.context.client._daemon_mod.rpc",
            side_effect=ConnectionRefusedError("refused"),
        ), mock.patch(
            "agentrail.context.client._daemon_mod.start_detached"
        ) as m_spawn:
            client = _resolve_context_client(self._tmp)
        m_spawn.assert_called_once_with(self._tmp)
        self.assertIsInstance(client, _ColdClient)


if __name__ == "__main__":
    unittest.main()
