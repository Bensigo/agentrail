"""Tests for the shared clone-auth helpers (agentrail/sandbox/clone_auth.py, #1268).

This is the canonical implementation both `native_runner.py` (re-imported
under its original private names — see that module's own test suite,
test_native_runner.py::TestAuthenticatedCloneUrl/TestRedactToken, which stays
green unchanged) and `onboard.py` (the new caller #1268 wires up) import from.
"""
from __future__ import annotations

from agentrail.sandbox.clone_auth import authenticated_clone_url, redact_token


class TestAuthenticatedCloneUrl:
    def test_embeds_token_in_https_url(self) -> None:
        url = authenticated_clone_url("https://github.com/acme/widgets.git", "ght-secret")
        assert url == "https://x-access-token:ght-secret@github.com/acme/widgets.git"

    def test_no_token_leaves_url_unchanged(self) -> None:
        url = authenticated_clone_url("https://github.com/acme/widgets.git", "")
        assert url == "https://github.com/acme/widgets.git"

    def test_ssh_url_is_never_modified_even_with_a_token(self) -> None:
        url = authenticated_clone_url("git@github.com:acme/widgets.git", "ght-secret")
        assert url == "git@github.com:acme/widgets.git"


class TestRedactToken:
    def test_strips_every_occurrence(self) -> None:
        text = (
            "fatal: unable to access 'https://x-access-token:ght-secret@github.com/x'\n"
            "ght-secret again"
        )
        out = redact_token(text, "ght-secret")
        assert "ght-secret" not in out
        assert out.count("***") == 2

    def test_no_token_is_a_no_op(self) -> None:
        assert redact_token("some log text", "") == "some log text"

    def test_redacts_a_python_subprocess_exception_message(self) -> None:
        """Ground-truth #1268 finding: subprocess.CalledProcessError/
        TimeoutExpired.__str__() embeds the raw argv it was constructed with —
        including a credential-embedded clone URL — regardless of what the
        child process itself printed. Confirmed empirically:
        `subprocess.run([..., "https://x-access-token:TOKEN@github.com/o/r", ...], check=True)`
        on a nonzero exit raises a CalledProcessError whose str() is exactly
        this shape. redact_token must clean it.
        """
        token = "ghp_realtoken1234567890"
        exc_str = (
            "Command '['git', 'clone', '--depth', '1', "
            f"'https://x-access-token:{token}@github.com/owner/repo', "
            "'/tmp/dest']' returned non-zero exit status 128."
        )
        out = redact_token(exc_str, token)
        assert token not in out
        assert "***" in out
