"""Bound + secret-scrub a raw log/error excerpt before it leaves the machine.

Failure ``evidence`` (verify-gate output, failing-test tail, TRAIL excerpt,
runner logs_tail) lands in a UI-facing ClickHouse column and future LLM context.
Two producers push it — the local pipeline/AFK runner (``failure_push``) and the
self-hosted runner client — so the bounding + scrubbing lives here, once.

Bounding order matters: keep only the last N lines (the tail is where the error
is), THEN secret-scrub, THEN byte-cap. Scrubbing the line-bounded tail before the
byte cap guarantees the cap can never bisect a credential and leak a fragment the
detectors no longer recognise.
"""
from __future__ import annotations

from agentrail.context.redaction import redact_text

EVIDENCE_MAX_LINES = 200
EVIDENCE_MAX_BYTES = 16 * 1024


def bound_evidence(evidence: str) -> str:
    """Tail → scrub → byte-cap. Empty in, empty out."""
    if not evidence:
        return ""
    lines = evidence.splitlines()
    if len(lines) > EVIDENCE_MAX_LINES:
        lines = lines[-EVIDENCE_MAX_LINES:]
    scrubbed = redact_text("\n".join(lines)).text
    encoded = scrubbed.encode("utf-8", "replace")
    if len(encoded) > EVIDENCE_MAX_BYTES:
        scrubbed = encoded[-EVIDENCE_MAX_BYTES:].decode("utf-8", "replace")
    return scrubbed
