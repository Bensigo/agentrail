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


def _pid_alive(pid: int) -> bool:
    """True if a process with this pid still exists — a liveness check via
    signal 0, which sends no actual signal and only probes existence."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _garbage_protocol_recipe(port: int) -> PreviewRecipe:
    """Binds ``port`` for REAL (the TCP half of a probe succeeds) but
    speaks garbage, not HTTP: any GET raises ``http.client.HTTPException``
    (e.g. ``BadStatusLine``), which is NOT an ``OSError`` subclass (C1) —
    a realistic case for a misconfigured recipe or a hostile PR."""
    script = textwrap.dedent(
        f"""
        import socket
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", {port}))
        srv.listen(5)
        while True:
            conn, _addr = srv.accept()
            conn.sendall(b"NOT_AN_HTTP_STATUS_LINE_AT_ALL\\r\\n\\r\\n")
            conn.close()
        """
    )
    return PreviewRecipe(
        install=None,
        start=[sys.executable, "-c", script],
        port=port,
        ready_path="/",
    )


@contextlib.contextmanager
def _black_hole_listener(port: int):
    """Accepts TCP connections (so the TCP half of a probe succeeds
    immediately) but never sends a byte back — makes the HTTP half of a
    single probe attempt consume its full timeout. Used to prove
    health_check's deadline overshoot is bounded (M1)."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(5)
    srv.settimeout(0.2)
    stop = threading.Event()
    conns: list = []

    def _accept_loop() -> None:
        while not stop.is_set():
            try:
                conn, _addr = srv.accept()
                conns.append(conn)  # keep open; never write to or close it
            except socket.timeout:
                continue
            except OSError:
                break

    thread = threading.Thread(target=_accept_loop, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=2)
        for conn in conns:
            with contextlib.suppress(OSError):
                conn.close()
        srv.close()


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


class TestHealthCheckDeadlineDiscipline:
    """M1 (review round 1): a single probe attempt starting near the
    deadline must not itself be allowed to run for its full fixed budget
    (~2s) past that deadline — total wall time should stay within a small
    margin of the caller's requested ``timeout``."""

    def test_total_wall_time_stays_within_a_small_margin_of_the_requested_timeout(
        self,
    ) -> None:
        port = pick_free_port()
        timeout = 0.3
        with _black_hole_listener(port):
            start = time.monotonic()
            result = health_check(port, "/", timeout=timeout, interval=0.2)
            elapsed = time.monotonic() - start

        assert result is False
        # OLD behavior: a probe starting right at the deadline could itself
        # take up to ~2s (the fixed connect+HTTP probe budget), overshooting
        # a 0.3s request by nearly 2s. Bounded now to a small margin.
        assert elapsed < timeout + 0.6, f"overshot {timeout}s budget: took {elapsed:.2f}s"


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
        runner = _StubRunner(
            [_StubCompleted(0), _StubCompleted(0), _StubCompleted(0), _StubCompleted(0)]
        )

        clone_pr_head(
            "https://github.com/acme/widgets.git", ref, dest,
            token="ght-secret", runner=runner,
        )

        assert len(runner.calls) == 4
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
        # S1: the credential-scrub step resets origin to the ORIGINAL,
        # never-tokened repo_url (never clone_url) — must never itself
        # carry "ght-secret".
        scrub_argv, scrub_kwargs = runner.calls[3]
        assert scrub_argv == [
            "git", "remote", "set-url", "origin",
            "https://github.com/acme/widgets.git",
        ]
        assert scrub_kwargs.get("cwd") == dest

    def test_a_pr_head_ref_is_passed_through_to_fetch_untouched(self, tmp_path: Path) -> None:
        """ref can be refs/pull/N/head — clone_pr_head must never try to
        --branch it (git rejects that form); it flows straight into fetch."""
        dest = str(tmp_path / "clone")
        runner = _StubRunner(
            [_StubCompleted(0), _StubCompleted(0), _StubCompleted(0), _StubCompleted(0)]
        )

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

    def test_token_straddling_the_truncation_boundary_is_still_fully_redacted(
        self, tmp_path: Path
    ) -> None:
        """I1 (review round 1): the OLD code truncated stderr to its last
        500 chars BEFORE redacting, so a token straddling that cutoff lost
        its matching prefix and a fragment survived untouched. Position the
        token so the cut lands strictly inside it, and assert on a
        distinguishing tail fragment — not just the full token — since a
        naive "token not in message" check alone wouldn't catch a PARTIAL
        leak (the surviving fragment isn't the complete token string)."""
        dest = str(tmp_path / "clone")
        token = "ghp_" + "".join(f"{i:03d}" for i in range(15))  # 49 unique chars
        tail_fragment = token[-12:]

        prefix = "F" * 40
        suffix = "S" * 480
        leaking_stderr = prefix + token + suffix
        # Sanity-check the fixture itself: the [-500:] cut must land
        # strictly inside the token, not before or after it, or this test
        # wouldn't actually exercise the straddling case it claims to.
        cut_from_start = len(leaking_stderr) - 500
        assert len(prefix) < cut_from_start < len(prefix) + len(token)

        runner = _StubRunner([_StubCompleted(1, "", leaking_stderr)])

        with pytest.raises(RuntimeError) as exc_info:
            clone_pr_head(
                "https://github.com/acme/widgets.git", "deadbeef", dest,
                token=token, runner=runner,
            )

        message = str(exc_info.value)
        assert token not in message
        assert tail_fragment not in message, "a fragment of the token leaked past truncation"


# ---------------------------------------------------------------------------
# clone_pr_head — credential scrub (final review, S1)
#
# TestBootEnvSecurityInvariant (below) proves the booted child's ENVIRONMENT
# is clean. It says nothing about DISK: `git clone` persists whatever URL
# it was given — including the token `authenticated_clone_url` embeds —
# verbatim into dest/.git/config, and boot() then runs the repo's OWN
# untrusted install/start commands with cwd=dest, which can trivially read
# that file. clone_pr_head must scrub it before ever returning.
# ---------------------------------------------------------------------------


class TestClonePrHeadCredentialScrub:
    def test_a_failing_scrub_step_raises_instead_of_returning_with_a_tokened_config(
        self, tmp_path: Path
    ) -> None:
        """A scrub failure must never be swallowed — better to fail the
        whole clone than let boot() ever see a dest whose config still
        carries the token."""
        dest = str(tmp_path / "clone")
        token = "ghp_x"
        runner = _StubRunner(
            [
                _StubCompleted(0),  # clone
                _StubCompleted(0),  # fetch
                _StubCompleted(0),  # checkout
                _StubCompleted(1, "", "fatal: could not set 'remote.origin.url'"),  # scrub
            ]
        )

        with pytest.raises(RuntimeError):
            clone_pr_head(
                "https://github.com/acme/widgets.git", "deadbeef", dest,
                token=token, runner=runner,
            )

        assert len(runner.calls) == 4  # the scrub step was actually attempted
        scrub_argv, scrub_kwargs = runner.calls[3]
        assert scrub_argv == [
            "git", "remote", "set-url", "origin",
            "https://github.com/acme/widgets.git",
        ]
        assert scrub_kwargs.get("cwd") == dest

    def test_the_credential_does_not_survive_on_disk_after_a_real_local_clone(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Reproduces the S1 finding exactly as the reviewer did: a REAL
        `git clone`/`fetch`/`checkout` (real subprocess, real git, no
        stubs) whose remote URL carries a fake token, then asserts the
        token is gone from BOTH `git config --get remote.origin.url` and a
        raw read of dest/.git/config afterward.

        There's no reachable real GitHub host to clone from offline, so
        `authenticated_clone_url` (the only thing that would normally turn
        an https:// repo_url into a tokened one) is swapped for a fake that
        points at a real local source repo instead, via a `file://` URL
        carrying the SAME `x-access-token:<token>@` userinfo prefix
        `authenticated_clone_url` itself would produce — confirmed
        empirically (outside this suite) that git happily clones through a
        fake userinfo prefix on a file:// URL AND persists it byte-for-byte
        into dest/.git/config, exactly like the reviewer's https:// repro.
        `repo_url` itself — what clone_pr_head receives, and what the
        scrub must reset origin back to — is never touched by the fake: it
        stays a plain, realistic https:// URL throughout, exactly as in
        production.
        """
        import agentrail.sandbox.preview_boot as preview_boot_module

        source = tmp_path / "source"
        subprocess.run(
            ["git", "init", "-q", "-b", "main", str(source)],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(source), "config", "user.email", "test@example.com"],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(source), "config", "user.name", "Test"],
            check=True, capture_output=True, text=True,
        )
        (source / "README.md").write_text("hello\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(source), "add", "README.md"],
            check=True, capture_output=True, text=True,
        )
        subprocess.run(
            ["git", "-C", str(source), "-c", "commit.gpgsign=false",
             "commit", "-q", "-m", "init"],
            check=True, capture_output=True, text=True,
        )
        sha = subprocess.run(
            ["git", "-C", str(source), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        token = "ghp_realtoken1234567890"
        clean_repo_url = "https://github.com/acme/widgets.git"  # never actually contacted
        dest = tmp_path / "dest"

        def _fake_authenticated_clone_url(repo_url: str, tok: str) -> str:
            assert (repo_url, tok) == (clean_repo_url, token)
            return f"file://x-access-token:{tok}@{source}"

        monkeypatch.setattr(
            preview_boot_module, "authenticated_clone_url", _fake_authenticated_clone_url
        )

        clone_pr_head(clean_repo_url, sha, str(dest), token=token, runner=subprocess)

        # The working tree is real and must remain intact — boot() needs it.
        assert (dest / "README.md").read_text(encoding="utf-8") == "hello\n"

        remaining_url = subprocess.run(
            ["git", "-C", str(dest), "config", "--get", "remote.origin.url"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        assert token not in remaining_url
        assert remaining_url == clean_repo_url  # reset to repo_url, not just token-stripped

        raw_config = (dest / ".git" / "config").read_text(encoding="utf-8")
        assert token not in raw_config


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


class TestBootHealthCheckExceptionSafety:
    """C1 (review round 1): an exception escaping health_check must never
    skip boot()'s cleanup. Two independent proofs:
      (a) a REAL untrusted process that triggers the actual gap found (a
          non-HTTP response raising http.client.HTTPException, which
          _probe_once's old except clause did not catch), and
      (b) a monkeypatched health_check raising something arbitrary,
          proving boot()'s OWN try/except safety net works on its own,
          independent of how exhaustive _probe_once's except clause is —
          the brief's "fix BOTH" ask.
    """

    def test_non_http_response_on_the_port_still_raises_boot_error_and_cleans_up(
        self, clone_dir: str
    ) -> None:
        port = pick_free_port()
        recipe = _garbage_protocol_recipe(port)

        with pytest.raises(BootError):
            boot(
                recipe, clone_dir, advertise_host="127.0.0.1",
                process_env=dict(os.environ), timeout=2.0,
            )

        assert not os.path.exists(clone_dir)
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5)

    def test_boot_cleans_up_even_if_health_check_itself_raises_unexpectedly(
        self, clone_dir: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import agentrail.sandbox.preview_boot as preview_boot_module

        port = pick_free_port()
        recipe = _http_server_recipe(port)

        def _boom(*_args: Any, **_kwargs: Any) -> bool:
            raise ValueError("simulated unexpected health_check failure")

        monkeypatch.setattr(preview_boot_module, "health_check", _boom)

        with pytest.raises(BootError):
            boot(
                recipe, clone_dir, advertise_host="127.0.0.1",
                process_env=dict(os.environ), timeout=3.0,
            )

        assert not os.path.exists(clone_dir)
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5)


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


class TestRunInstallProcessGroupDiscipline:
    """C2 (review round 1): the install step must get the SAME
    process-group discipline as the boot child — file-logged (not piped)
    stdout/stderr, and a killpg on every exit path. Without it, a
    backgrounded grandchild (e.g. from an attacker-controlled npm
    ``postinstall``) both re-introduces the exact pipe-deadlock this
    module documents avoiding for the boot child, AND survives cleanup."""

    def test_a_backgrounded_grandchild_does_not_block_install_for_the_full_timeout(
        self, tmp_path: Path, clone_dir: str
    ) -> None:
        port = pick_free_port()
        pid_file = tmp_path / "grandchild.pid"
        install_script = tmp_path / "install_backgrounds_a_grandchild.py"
        install_script.write_text(
            textwrap.dedent(
                f"""
                import subprocess, sys
                # Inherits OUR stdout/stderr (the pipe-deadlock hazard) and
                # is NOT setsid'd (stays in our process group — the
                # killpg-reachability hazard). Outlives this script.
                gc = subprocess.Popen([sys.executable, "-c",
                                        "import time; time.sleep(30)"])
                with open({str(pid_file)!r}, "w") as fh:
                    fh.write(str(gc.pid))
                sys.exit(0)
                """
            ),
            encoding="utf-8",
        )
        recipe = PreviewRecipe(
            install=[sys.executable, str(install_script)],
            start=[sys.executable, "-m", "http.server", str(port)],
            port=port,
            ready_path="/",
        )

        start = time.monotonic()
        handle = boot(
            recipe, clone_dir, advertise_host="127.0.0.1",
            process_env=dict(os.environ), timeout=6.0,
        )
        elapsed = time.monotonic() - start
        try:
            # The install script itself exits almost instantly; the old
            # pipe-based capture would instead block this for the FULL 6s
            # timeout regardless, waiting on the grandchild's pipe end.
            assert elapsed < 3.0, f"install blocked on the grandchild's pipe: took {elapsed:.2f}s"
        finally:
            teardown(handle)

        grandchild_pid = int(pid_file.read_text().strip())
        assert not _pid_alive(grandchild_pid), (
            "install's grandchild survived — leaked outside process-group cleanup"
        )

    def test_install_timeout_kills_the_whole_group_including_a_grandchild(
        self, tmp_path: Path, clone_dir: str
    ) -> None:
        port = pick_free_port()
        pid_file = tmp_path / "grandchild.pid"
        install_script = tmp_path / "install_hangs_after_backgrounding.py"
        install_script.write_text(
            textwrap.dedent(
                f"""
                import subprocess, sys, time
                gc = subprocess.Popen([sys.executable, "-c",
                                        "import time; time.sleep(30)"])
                with open({str(pid_file)!r}, "w") as fh:
                    fh.write(str(gc.pid))
                time.sleep(30)  # the install command itself never finishes
                """
            ),
            encoding="utf-8",
        )
        recipe = PreviewRecipe(
            install=[sys.executable, str(install_script)],
            start=[sys.executable, "-m", "http.server", str(port)],
            port=port,
            ready_path="/",
        )

        with pytest.raises(BootError):
            boot(
                recipe, clone_dir, advertise_host="127.0.0.1",
                process_env=dict(os.environ), timeout=1.5,
            )

        assert not os.path.exists(clone_dir)
        grandchild_pid = int(pid_file.read_text().strip())
        assert not _pid_alive(grandchild_pid), (
            "install's grandchild survived an install timeout — leaked"
        )


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
