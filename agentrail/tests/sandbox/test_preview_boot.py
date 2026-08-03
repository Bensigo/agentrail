"""Tests for the boot lifecycle (agentrail/sandbox/preview_boot.py, B2b Task 6).

``clone_pr_head`` / ``boot`` / ``teardown`` clone a PR head, boot it as a
supervised child process, health-check it over TCP+HTTP, and tear it down.
The boot child runs UNTRUSTED repo code, so the load-bearing property under
test throughout is: the child's environment is built ONLY through
``build_native_child_env`` (agentrail/sandbox/native_runner.py) — never a
raw copy of the caller's/fleet's own process env. ``TestBootEnvSecurityInvariant``
proves this against a REAL spawned child that dumps its own environment,
not a mock.

Everything here either:
  - uses an INJECTED fake ``runner`` (``clone_pr_head`` — no real network,
    mirrors ``agentrail.runner.onboard``'s own ``_clone`` test convention), or
  - boots a REAL local child process over loopback TCP (``boot``/
    ``health_check``/``teardown`` — no mocks; a real ``http.server`` or a
    tiny hand-rolled ``BaseHTTPRequestHandler`` is what "serves" here).
"""
from __future__ import annotations

import contextlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import textwrap
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

import pytest

from agentrail.sandbox.preview_boot import (
    BootError,
    BootHandle,
    boot,
    clone_pr_head,
    health_check,
    pick_free_port,
    teardown,
)
from agentrail.sandbox.preview_recipe import PreviewRecipe

# ---------------------------------------------------------------------------
# Shared fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def clone_dir(tmp_path: Path) -> str:
    d = tmp_path / "clone"
    d.mkdir()
    return str(d)


def _http_server_recipe(port: int, *, ready_path: str = "/") -> PreviewRecipe:
    """A REAL bootable server: python's own stdlib http.server, serving
    clone_dir as a directory listing on ``/``."""
    return PreviewRecipe(
        install=None,
        start=[sys.executable, "-m", "http.server", str(port)],
        port=port,
        ready_path=ready_path,
    )


def _never_listens_recipe(port: int, marker: str) -> PreviewRecipe:
    """A REAL process that starts and keeps running, but never binds
    ``port`` — the health-fail path. ``marker`` is a unique string baked
    into argv so a leaked process (if cleanup were buggy) is findable via
    ``pgrep -f``."""
    return PreviewRecipe(
        install=None,
        start=[sys.executable, "-c", f"import time; _MARKER = {marker!r}; time.sleep(10)"],
        port=port,
        ready_path="/",
    )


class _OkHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib handler naming
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args: Any) -> None:  # silence test output
        pass


class _ServiceUnavailableHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(503)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"no")

    def log_message(self, *args: Any) -> None:
        pass


@contextlib.contextmanager
def _running_http_server(port: int, handler_cls: type):
    httpd = http.server.HTTPServer(("127.0.0.1", port), handler_cls)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield httpd
    finally:
        httpd.shutdown()
        thread.join(timeout=2)
        httpd.server_close()


# ---------------------------------------------------------------------------
# pick_free_port
# ---------------------------------------------------------------------------


class TestPickFreePort:
    def test_returns_a_port_that_can_actually_be_bound(self) -> None:
        port = pick_free_port()
        assert isinstance(port, int)
        assert 1 <= port <= 65535
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))  # raises OSError if not actually free

    def test_repeated_calls_are_not_pinned_to_a_single_port(self) -> None:
        ports = {pick_free_port() for _ in range(5)}
        assert len(ports) > 1


# ---------------------------------------------------------------------------
# health_check
# ---------------------------------------------------------------------------


class TestHealthCheck:
    def test_true_once_server_is_listening_and_ready_path_is_ok(self) -> None:
        port = pick_free_port()
        with _running_http_server(port, _OkHandler):
            assert health_check(port, "/", timeout=3.0, interval=0.1) is True

    def test_false_when_nothing_listens_within_the_deadline(self) -> None:
        port = pick_free_port()  # guaranteed free right now; nothing binds it
        start = time.monotonic()
        assert health_check(port, "/", timeout=0.6, interval=0.1) is False
        # Must respect the deadline, not hang indefinitely.
        assert time.monotonic() - start < 5.0

    def test_false_while_ready_path_keeps_returning_5xx(self) -> None:
        port = pick_free_port()
        with _running_http_server(port, _ServiceUnavailableHandler):
            assert health_check(port, "/", timeout=0.6, interval=0.1) is False

    def test_polls_until_the_server_starts_listening_after_a_delay(self) -> None:
        """Proves this is a real retry loop, not a single check: nothing is
        listening when health_check starts probing; the server only starts
        ~0.4s later, well inside the 3s deadline."""
        port = pick_free_port()
        started = threading.Event()
        box: list = []

        def _delayed_start() -> None:
            time.sleep(0.4)
            httpd = http.server.HTTPServer(("127.0.0.1", port), _OkHandler)
            box.append(httpd)
            started.set()
            httpd.serve_forever()

        thread = threading.Thread(target=_delayed_start, daemon=True)
        thread.start()
        try:
            assert health_check(port, "/", timeout=3.0, interval=0.1) is True
        finally:
            started.wait(timeout=2)
            if box:
                box[0].shutdown()
                box[0].server_close()
            thread.join(timeout=2)


# ---------------------------------------------------------------------------
# clone_pr_head — injected fake runner, no network
# ---------------------------------------------------------------------------


class _StubCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _StubRunner:
    """Records every ``.run()`` call and returns/raises the next scripted
    outcome. No real process is ever spawned — this is the injection seam
    ``agentrail.runner.onboard._clone`` uses for the same reason."""

    def __init__(self, outcomes: list) -> None:
        self._outcomes = list(outcomes)
        self.calls: list[tuple[list, dict]] = []

    def run(self, argv: list, **kwargs: Any):
        self.calls.append((list(argv), kwargs))
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class TestClonePrHead:
    def test_argv_sequence_is_clone_then_fetch_ref_then_checkout_fetch_head(
        self, tmp_path: Path
    ) -> None:
        dest = str(tmp_path / "clone")
        ref = "deadbeefcafefeed0000000000000000000000"
        runner = _StubRunner([_StubCompleted(0), _StubCompleted(0), _StubCompleted(0)])

        clone_pr_head(
            "https://github.com/acme/widgets.git", ref, dest,
            token="ght-secret", runner=runner,
        )

        assert len(runner.calls) == 3
        clone_argv, _ = runner.calls[0]
        assert clone_argv == [
            "git", "clone", "--depth", "1",
            "https://x-access-token:ght-secret@github.com/acme/widgets.git",
            dest,
        ]
        fetch_argv, fetch_kwargs = runner.calls[1]
        assert fetch_argv == ["git", "fetch", "--depth", "1", "origin", ref]
        assert fetch_kwargs.get("cwd") == dest
        checkout_argv, checkout_kwargs = runner.calls[2]
        assert checkout_argv == ["git", "checkout", "FETCH_HEAD"]
        assert checkout_kwargs.get("cwd") == dest

    def test_a_pr_head_ref_is_passed_through_to_fetch_untouched(self, tmp_path: Path) -> None:
        """ref can be refs/pull/N/head — clone_pr_head must never try to
        --branch it (git rejects that form); it flows straight into fetch."""
        dest = str(tmp_path / "clone")
        runner = _StubRunner([_StubCompleted(0), _StubCompleted(0), _StubCompleted(0)])

        clone_pr_head(
            "https://github.com/acme/widgets.git", "refs/pull/42/head", dest,
            token="", runner=runner,
        )

        fetch_argv, _ = runner.calls[1]
        assert fetch_argv == ["git", "fetch", "--depth", "1", "origin", "refs/pull/42/head"]
        clone_argv, _ = runner.calls[0]
        assert "refs/pull/42/head" not in clone_argv  # never passed to --branch

    def test_token_is_redacted_from_a_failed_clones_stderr(self, tmp_path: Path) -> None:
        dest = str(tmp_path / "clone")
        token = "ghp_realtoken1234567890"
        leaking_stderr = (
            f"fatal: unable to access 'https://x-access-token:{token}@github.com/x': "
            "The requested URL returned error: 403"
        )
        runner = _StubRunner([_StubCompleted(128, "", leaking_stderr)])

        with pytest.raises(RuntimeError) as exc_info:
            clone_pr_head(
                "https://github.com/acme/widgets.git", "deadbeef", dest,
                token=token, runner=runner,
            )

        assert token not in str(exc_info.value)

    def test_token_is_redacted_from_a_raised_subprocess_exception_message(
        self, tmp_path: Path
    ) -> None:
        """Ground truth per clone_auth.py's own docstring:
        CalledProcessError/TimeoutExpired.__str__() unconditionally embeds
        the raw argv it was constructed with — including a
        credential-embedded URL — regardless of what the child printed.
        clone_pr_head must redact that too, not just stderr text."""
        dest = str(tmp_path / "clone")
        token = "ghp_realtoken1234567890"
        authed_url = f"https://x-access-token:{token}@github.com/acme/widgets.git"
        exc = subprocess.TimeoutExpired(
            cmd=["git", "clone", "--depth", "1", authed_url, dest], timeout=120.0,
        )
        runner = _StubRunner([exc])

        with pytest.raises(RuntimeError) as exc_info:
            clone_pr_head(
                "https://github.com/acme/widgets.git", "deadbeef", dest,
                token=token, runner=runner,
            )

        assert token not in str(exc_info.value)

    def test_a_failed_fetch_stops_before_checkout_and_is_redacted(self, tmp_path: Path) -> None:
        dest = str(tmp_path / "clone")
        token = "ghp_x"
        runner = _StubRunner(
            [
                _StubCompleted(0),
                _StubCompleted(1, "", f"fatal: couldn't find remote ref (saw token {token})"),
            ]
        )

        with pytest.raises(RuntimeError) as exc_info:
            clone_pr_head(
                "https://github.com/acme/widgets.git", "deadbeef", dest,
                token=token, runner=runner,
            )

        assert len(runner.calls) == 2  # checkout never attempted
        assert token not in str(exc_info.value)


# ---------------------------------------------------------------------------
# boot / teardown — real fixture lifecycle
# ---------------------------------------------------------------------------


class TestBootLifecycle:
    def test_full_lifecycle_boot_serves_then_teardown_kills_group_and_removes_dir(
        self, clone_dir: str
    ) -> None:
        port = pick_free_port()
        recipe = _http_server_recipe(port)

        handle = boot(
            recipe, clone_dir, advertise_host="127.0.0.1",
            process_env=dict(os.environ), timeout=10.0,
        )
        assert isinstance(handle, BootHandle)
        assert handle.port == port
        assert handle.url == f"http://127.0.0.1:{port}"
        assert handle.clone_dir == clone_dir
        assert handle.proc.poll() is None  # still running right after boot

        pid = handle.proc.pid
        try:
            # The port genuinely serves — not just that health_check said so.
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=3.0) as resp:
                assert resp.status == 200
        finally:
            teardown(handle)

        assert handle.proc.poll() is not None  # reaped: the pid is gone
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
        assert not os.path.exists(clone_dir)

        teardown(handle)  # idempotent: calling again must not raise

    def test_health_fail_raises_boot_error_and_leaves_no_process_or_dir(
        self, clone_dir: str
    ) -> None:
        port = pick_free_port()
        marker = "agentrail-b2b-task6-leak-probe"
        recipe = _never_listens_recipe(port, marker)

        with pytest.raises(BootError) as exc_info:
            boot(
                recipe, clone_dir, advertise_host="127.0.0.1",
                process_env=dict(os.environ), timeout=1.5,
            )

        assert str(exc_info.value)  # carries a reason / log tail
        assert not os.path.exists(clone_dir)
        # Nothing is bound to the port — no leaked server.
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5)
        # Belt-and-suspenders where pgrep exists: no process anywhere still
        # carries this run's unique marker in its argv.
        if shutil.which("pgrep"):
            result = subprocess.run(["pgrep", "-f", marker], capture_output=True, text=True)
            assert result.returncode != 0, f"leaked process still running: {result.stdout}"


class TestBootInstallStep:
    def test_install_failure_raises_boot_error_and_never_spawns_start(
        self, clone_dir: str
    ) -> None:
        port = pick_free_port()
        recipe = PreviewRecipe(
            install=[sys.executable, "-c", "import sys; sys.exit(3)"],
            start=[sys.executable, "-m", "http.server", str(port)],
            port=port,
            ready_path="/",
        )

        with pytest.raises(BootError):
            boot(
                recipe, clone_dir, advertise_host="127.0.0.1",
                process_env=dict(os.environ), timeout=10.0,
            )

        assert not os.path.exists(clone_dir)
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.3)


# ---------------------------------------------------------------------------
# The mandatory security invariant (Task 6 brief, load-bearing)
# ---------------------------------------------------------------------------


class TestBootEnvSecurityInvariant:
    """The boot child is UNTRUSTED repo code. Its env must be built ONLY
    through ``build_native_child_env`` — never a raw copy of the caller's
    process env. Proven here against a REAL spawned child that dumps its
    own ``os.environ`` to a file before serving, so this is direct evidence
    of what the child actually saw, not an inspection of our own call args."""

    def test_fleet_secrets_never_reach_the_booted_childs_actual_environment(
        self, tmp_path: Path, clone_dir: str
    ) -> None:
        port = pick_free_port()
        env_dump_path = tmp_path / "child-env.json"
        script_path = tmp_path / "dump_env_then_serve.py"
        script_path.write_text(
            textwrap.dedent(
                f"""
                import json, os, sys
                import http.server, socketserver

                port = int(sys.argv[1])
                with open({str(env_dump_path)!r}, "w") as fh:
                    json.dump(dict(os.environ), fh)

                class Handler(http.server.SimpleHTTPRequestHandler):
                    def log_message(self, *a):
                        pass

                with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
                    httpd.serve_forever()
                """
            ),
            encoding="utf-8",
        )
        recipe = PreviewRecipe(
            install=None,
            start=[sys.executable, str(script_path), str(port)],
            port=port,
            ready_path="/",
        )

        # Simulate the REAL fleet process env: it legitimately contains
        # these secrets (os.environ does, on the real host) — the boundary
        # must strip them before the untrusted child ever sees them.
        fleet_process_env = dict(os.environ)
        fleet_process_env.update(
            {
                "DATABASE_URL": "postgres://prod-secret-host/db",
                "FLEET_CONSOLE_TOKEN": "fct-super-secret-mints-every-tenant",
                "AUTH_SECRET": "auth-super-secret",
            }
        )

        handle = boot(
            recipe, clone_dir, advertise_host="127.0.0.1",
            process_env=fleet_process_env, timeout=10.0,
        )
        try:
            child_env = json.loads(env_dump_path.read_text())
        finally:
            teardown(handle)

        assert "DATABASE_URL" not in child_env
        assert "FLEET_CONSOLE_TOKEN" not in child_env
        assert "AUTH_SECRET" not in child_env
        # Not a vacuous pass from an empty/broken env: legitimate vars DID
        # cross the boundary — proving the allowlist mechanism actually ran
        # rather than e.g. the child receiving env={} entirely.
        assert child_env.get("PORT") == str(port)
        assert child_env.get("HOST") == "0.0.0.0"
        assert "PATH" in child_env
