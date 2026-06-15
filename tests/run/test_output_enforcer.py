"""Unit tests for agentrail/run/output_enforcer.py.

Covers acceptance criteria AC1, AC2, and AC3 for issue #768.

AC1: A full-file rewrite of an existing file is rejected with a structured reason.
AC2: A diff/patch edit is accepted.
AC3: Full content is accepted for a new file or rename.
"""
from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agentrail.run.output_enforcer import Accepted, Rejected, enforce, push_format_rejection_event


# ---------------------------------------------------------------------------
# AC1: Full-file rewrite of existing file → Rejected
# ---------------------------------------------------------------------------

class TestEnforceRejectsFullRewrite:
    def test_plain_text_content_rejected(self):
        """Content with no hunk headers and is_new_or_rename=False → Rejected."""
        content = "def foo():\n    return 42\n\ndef bar():\n    return 'hello'\n"
        result = enforce(content, is_new_or_rename=False)
        assert isinstance(result, Rejected)

    def test_rejection_includes_reason(self):
        """Rejected result must carry a non-empty reason string."""
        result = enforce("x = 1\ny = 2\n", is_new_or_rename=False)
        assert isinstance(result, Rejected)
        assert result.reason
        assert len(result.reason) > 0

    def test_rejection_reason_mentions_hunk_header(self):
        """Reason should guide the agent toward the expected format."""
        result = enforce("full file content here", is_new_or_rename=False)
        assert isinstance(result, Rejected)
        assert "@@" in result.reason

    def test_large_content_no_diff_markers_rejected(self):
        """Large text without @@ markers is still rejected."""
        content = "\n".join(f"line {i}" for i in range(500))
        result = enforce(content, is_new_or_rename=False)
        assert isinstance(result, Rejected)

    def test_empty_content_rejected(self):
        """Empty content (clearing a file without a diff) is rejected for existing files."""
        result = enforce("", is_new_or_rename=False)
        assert isinstance(result, Rejected)

    def test_default_is_new_or_rename_false(self):
        """Default is_new_or_rename=False: plain content without diff is rejected."""
        result = enforce("some full file content")
        assert isinstance(result, Rejected)


# ---------------------------------------------------------------------------
# AC2: Diff/patch edit → Accepted
# ---------------------------------------------------------------------------

class TestEnforceAcceptsDiff:
    def test_unified_diff_with_hunk_header(self):
        """Content containing a unified-diff hunk header is accepted."""
        diff = (
            "--- a/src/foo.py\n"
            "+++ b/src/foo.py\n"
            "@@ -1,5 +1,6 @@\n"
            " def foo():\n"
            "-    return 42\n"
            "+    return 43\n"
            " \n"
        )
        result = enforce(diff, is_new_or_rename=False)
        assert isinstance(result, Accepted)

    def test_hunk_header_without_context_lines(self):
        """@@ -1 +1 @@ (no comma form) is accepted."""
        diff = "@@ -1 +1 @@\n-old line\n+new line\n"
        result = enforce(diff, is_new_or_rename=False)
        assert isinstance(result, Accepted)

    def test_multiple_hunks_accepted(self):
        """Multiple @@ blocks (multi-hunk patch) is accepted."""
        diff = (
            "@@ -1,3 +1,3 @@\n"
            " a\n"
            "-b\n"
            "+B\n"
            " c\n"
            "@@ -10,3 +10,4 @@\n"
            " x\n"
            "+new line\n"
            " y\n"
        )
        result = enforce(diff, is_new_or_rename=False)
        assert isinstance(result, Accepted)

    def test_diff_embedded_in_larger_text(self):
        """A @@ hunk header anywhere in the content is enough to accept."""
        content = (
            "I made the following changes:\n\n"
            "--- a/main.py\n"
            "+++ b/main.py\n"
            "@@ -5,7 +5,8 @@\n"
            " existing = True\n"
            "+new_var = False\n"
        )
        result = enforce(content, is_new_or_rename=False)
        assert isinstance(result, Accepted)

    def test_hunk_header_with_section_label(self):
        """@@ ... @@ function_name label is accepted."""
        diff = "@@ -10,3 +10,4 @@ def my_function():\n- old\n+ new\n"
        result = enforce(diff, is_new_or_rename=False)
        assert isinstance(result, Accepted)


# ---------------------------------------------------------------------------
# AC3: New file or rename → Accepted regardless of format
# ---------------------------------------------------------------------------

class TestEnforceAcceptsNewOrRename:
    def test_new_file_full_content_accepted(self):
        """Full content is accepted when is_new_or_rename=True."""
        content = "def hello():\n    print('hello')\n"
        result = enforce(content, is_new_or_rename=True)
        assert isinstance(result, Accepted)

    def test_rename_empty_content_accepted(self):
        """Empty content with is_new_or_rename=True is still accepted."""
        result = enforce("", is_new_or_rename=True)
        assert isinstance(result, Accepted)

    def test_new_file_large_content_accepted(self):
        """New file with hundreds of lines accepted without diff markers."""
        content = "\n".join(f"line {i}" for i in range(300))
        result = enforce(content, is_new_or_rename=True)
        assert isinstance(result, Accepted)

    def test_rename_with_diff_markers_still_accepted(self):
        """A rename that also happens to include @@ is accepted (belt-and-suspenders)."""
        content = "@@ -1,3 +1,3 @@\n some content"
        result = enforce(content, is_new_or_rename=True)
        assert isinstance(result, Accepted)


# ---------------------------------------------------------------------------
# push_format_rejection_event — non-fatal push behaviour
# ---------------------------------------------------------------------------

class TestPushFormatRejectionEvent:
    def test_returns_false_when_not_linked(self, tmp_path):
        """No server.json and no env vars → returns False without raising."""
        result = push_format_rejection_event(tmp_path, "run-1", "execute", "full rewrite")
        assert result is False

    def test_returns_true_on_202(self, tmp_path):
        """HTTP 202 from the server → returns True."""
        (tmp_path / ".agentrail").mkdir()
        (tmp_path / ".agentrail" / "server.json").write_text(json.dumps({
            "base_url": "http://localhost:9000",
            "api_key": "test-key",
            "repository_id": "repo-1",
        }))

        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.status = 202

        with patch("urllib.request.urlopen", return_value=mock_resp):
            result = push_format_rejection_event(
                tmp_path, "run-1", "execute", "full rewrite detected"
            )
        assert result is True

    def test_returns_false_on_network_error(self, tmp_path):
        """Network failure → returns False without raising."""
        (tmp_path / ".agentrail").mkdir()
        (tmp_path / ".agentrail" / "server.json").write_text(json.dumps({
            "base_url": "http://localhost:9000",
            "api_key": "test-key",
            "repository_id": "repo-1",
        }))

        with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
            result = push_format_rejection_event(
                tmp_path, "run-1", "execute", "reason"
            )
        assert result is False

    def test_event_payload_shape(self, tmp_path):
        """The posted event must include expected fields."""
        (tmp_path / ".agentrail").mkdir()
        (tmp_path / ".agentrail" / "server.json").write_text(json.dumps({
            "base_url": "http://localhost:9000",
            "api_key": "test-key",
            "repository_id": "repo-1",
        }))

        captured: list[dict] = []

        def fake_urlopen(req, timeout=None):
            body = req.data
            captured.extend(json.loads(body))
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.status = 202
            return mock_resp

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            push_format_rejection_event(
                tmp_path, "run-42", "execute", "full rewrite of existing file"
            )

        assert len(captured) == 1
        ev = captured[0]
        assert ev["session_id"] == "run-42"
        assert ev["kind"] == "execute"
        assert ev["action"]["type"] == "output_format_rejected"
        assert ev["action"]["phase"] == "execute"
        assert "reason" in ev["action"]
