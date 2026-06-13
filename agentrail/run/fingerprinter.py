"""Normalize failure messages and derive stable fingerprints."""
from __future__ import annotations

import hashlib
import re


class FailureFingerprinter:
    """Stable fingerprinting for noisy error messages."""

    _memory_address_re = re.compile(r"\b0x[0-9a-fA-F]+\b")
    _uuid_re = re.compile(
        r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
        r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
    )
    _run_id_re = re.compile(r"\brun[-_][A-Za-z0-9][A-Za-z0-9._-]*\b")
    _run_id_assignment_re = re.compile(r"\brun_id=<uuid>\b|\brun_id=[A-Za-z0-9._:-]+\b")
    _absolute_path_re = re.compile(r"(?<![\w:])(?:/[A-Za-z0-9._@%+\-]+){2,}")
    _windows_path_re = re.compile(r"\b[A-Za-z]:\\(?:[^\\\s:]+\\)+[^\\\s:]+")
    _line_word_re = re.compile(r"\bline\s+\d+\b", re.IGNORECASE)
    _file_line_re = re.compile(r"(\.[A-Za-z0-9]{1,8}):\d+\b")
    _goroutine_re = re.compile(r"\bgoroutine\s+\d+\b")
    _duration_re = re.compile(
        r"\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b",
        re.IGNORECASE,
    )
    _numeric_suffix_re = re.compile(r"([A-Za-z][A-Za-z0-9]*[-_])\d+\b")
    _whitespace_re = re.compile(r"[ \t]+")

    def normalize(self, message: str) -> str:
        """Return a normalized error string suitable for clustering."""
        normalized = message or ""
        normalized = self._uuid_re.sub("<uuid>", normalized)
        normalized = self._memory_address_re.sub("<addr>", normalized)
        normalized = self._windows_path_re.sub(self._replace_windows_path, normalized)
        normalized = self._absolute_path_re.sub(self._replace_absolute_path, normalized)
        normalized = self._run_id_re.sub("<run_id>", normalized)
        normalized = self._run_id_assignment_re.sub("run_id=<run_id>", normalized)
        normalized = self._line_word_re.sub("line <line>", normalized)
        normalized = self._file_line_re.sub(r"\1:<line>", normalized)
        normalized = self._goroutine_re.sub("goroutine <n>", normalized)
        normalized = self._duration_re.sub("<duration>", normalized)
        normalized = self._numeric_suffix_re.sub(r"\1<n>", normalized)
        lines = [
            self._whitespace_re.sub(" ", line.strip())
            for line in normalized.splitlines()
            if line.strip()
        ]
        return "\n".join(lines)

    def fingerprint(self, message: str) -> str:
        """Return a deterministic fingerprint for a raw failure message."""
        normalized = self.normalize(message)
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
        return f"sha256:{digest}"

    @staticmethod
    def _replace_absolute_path(match: re.Match[str]) -> str:
        basename = match.group(0).rstrip("/").split("/")[-1]
        return f"<path>/{basename}" if basename else "<path>"

    @staticmethod
    def _replace_windows_path(match: re.Match[str]) -> str:
        basename = match.group(0).rstrip("\\").split("\\")[-1]
        return f"<path>/{basename}" if basename else "<path>"
