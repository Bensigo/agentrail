"""Tests for failure message normalization and fingerprinting."""
from __future__ import annotations

from agentrail.run.fingerprinter import FailureFingerprinter


def test_python_traceback_variants_have_identical_fingerprint() -> None:
    fingerprinter = FailureFingerprinter()
    first = """Traceback (most recent call last):
  File "/Users/alice/work/agentrail/agentrail/run/worker.py", line 41, in run
    raise RuntimeError("failed run run-20260613-081113")
RuntimeError: failed run run-20260613-081113 at 0x7ffeefbff5c0
"""
    second = """Traceback (most recent call last):
  File "/tmp/build-92817/agentrail/run/worker.py", line 309, in run
    raise RuntimeError("failed run run-20260613-091455")
RuntimeError: failed run run-20260613-091455 at 0x7fa1b2c3d4e5
"""

    assert fingerprinter.fingerprint(first) == fingerprinter.fingerprint(second)
    normalized = fingerprinter.normalize(first)
    assert "0x7ffeefbff5c0" not in normalized
    assert "/Users/alice" not in normalized
    assert "line 41" not in normalized
    assert "run-20260613-081113" not in normalized


def test_go_panic_variants_have_identical_fingerprint() -> None:
    fingerprinter = FailureFingerprinter()
    first = """panic: runtime error: invalid memory address or nil pointer dereference
goroutine 918 [running]:
main.(*Worker).Run(0xc00046a120)
    /home/ci/builds/run-019ebf2e/agentrail/cmd/worker/main.go:88 +0x31
"""
    second = """panic: runtime error: invalid memory address or nil pointer dereference
goroutine 42 [running]:
main.(*Worker).Run(0xc00099bff0)
    /private/tmp/run-019ebf9a/agentrail/cmd/worker/main.go:271 +0x91
"""

    assert fingerprinter.fingerprint(first) == fingerprinter.fingerprint(second)


def test_generic_error_variants_have_identical_fingerprint() -> None:
    fingerprinter = FailureFingerprinter()
    first = "Command /Users/alice/repo/scripts/test-123.sh failed on line 88 for run_id=019ebf2e-0d0f-7fe3-90a8-3530f6c3d761"
    second = "Command /tmp/repo/scripts/test-928.sh failed on line 12 for run_id=019ebf2e-0d0f-7fe3-90a8-111111111111"

    assert fingerprinter.fingerprint(first) == fingerprinter.fingerprint(second)


def test_distinct_error_messages_have_distinct_fingerprints() -> None:
    fingerprinter = FailureFingerprinter()

    assert fingerprinter.fingerprint("TypeError: missing name") != fingerprinter.fingerprint(
        "ConnectionError: database timeout"
    )
