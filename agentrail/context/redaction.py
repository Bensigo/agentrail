from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Pattern

from agentrail.context.models import RedactionFinding


@dataclass(frozen=True)
class RedactionResult:
    text: str
    findings: List[RedactionFinding]


@dataclass(frozen=True)
class Detector:
    name: str
    regex: Pattern[str]
    token: str


# NOTE on parity with the write-side ingest scanner
# (apps/console/lib/secret-scan.ts's `RULES`), checked 2026-07-04 for #1039's
# AC4 (memory-lane review, Defect #3):
#
# This list has been brought into parity with secret-scan.ts for every
# *specific, credential-shaped* pattern — the ones with a low false-positive
# rate because they match a distinctive token/key format (prefix + charset +
# length), not just a nearby keyword. Added/broadened in this pass:
#   - anthropic_key (new): sk-ant-... — previously only matched generically by
#     `api_key`'s bare `sk-` prefix, so it's still caught, but now also
#     reported/labeled distinctly like secret-scan.ts does.
#   - aws_secret_access_key (new): 40-char secret next to an aws/secret hint.
#   - token: broadened prefixes to ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ (was
#     ghp_/github_pat_ only).
#   - aws_access_key: broadened to AKIA|ASIA (was AKIA only).
#   - slack_token, google_api_key, jwt (new): distinctive formats with no
#     analogue here previously.
#   - database_url: broadened beyond the fixed postgres/mysql/redis/mongodb
#     scheme list to any `scheme://user:password@host` shape (matches
#     secret-scan.ts's scheme-agnostic connection_string_password rule),
#     since the fixed-scheme version misses e.g. sqlserver://, amqp://.
#     Requires the inline `user:password@` segment, same as the TS rule — a
#     credential-free `scheme://identifier` (e.g. an external-source URI)
#     must not match; an earlier pass here dropped that requirement and
#     over-redacted such identifiers (#1069).
#
# Intentionally NOT ported: secret-scan.ts's `generic_assigned_secret` rule
# (`(?:api_key|secret|password|token|...)\s*[=:]\s*.{8,}`). That rule is a
# broad keyword-adjacent-to-any-8-char-value catch-all — appropriate on the
# write side, which REJECTS the whole batch and returns the reason to the
# human author (a false positive just costs a re-submit). This read-side
# filter instead SILENTLY DROPS the memory item from the lane with no
# feedback to anyone (non-fatal, hermetic, no return channel to the author) —
# the equivalent generic pattern here would silently and unpredictably vanish
# ordinary advisory prose that merely mentions "password:" or "token:" in
# passing, with no way for the author to learn why. `secret_assignment` below
# (used only by `redact_text`, not by the memory-lane filter) already covers
# the structured-code-literal form of that same case with a tighter grammar
# (quoted assignment), so the coverage gap versus secret-scan.ts's fully
# generic version is a deliberate precision/silent-failure tradeoff, not an
# oversight.
DETECTORS = [
    Detector("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED:private_key]"),
    Detector("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"), "[REDACTED:anthropic_key]"),
    Detector("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{10,}\b"), "[REDACTED:api_key]"),
    Detector("token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b"), "[REDACTED:token]"),
    Detector("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), "[REDACTED:aws_access_key]"),
    Detector("aws_secret_access_key", re.compile(r"\baws.{0,20}(?:secret|access).{0,20}[=:]\s*['\"]?[A-Za-z0-9/+]{40}['\"]?", re.IGNORECASE), "[REDACTED:aws_secret_access_key]"),
    Detector("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "[REDACTED:slack_token]"),
    Detector("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "[REDACTED:google_api_key]"),
    Detector("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b"), "[REDACTED:jwt]"),
    Detector("database_url", re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s\"'`<>:/@]+:[^\s\"'`<>@]+@[^\s\"'`<>]+", re.IGNORECASE), "[REDACTED:database_url]"),
    Detector("bearer_token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b", re.IGNORECASE), "Bearer [REDACTED:bearer_token]"),
]


def _record(findings: List[RedactionFinding], detector: str, count: int = 1) -> None:
    for finding in findings:
        if finding.detector == detector:
            finding.count += count
            return
    findings.append(RedactionFinding(detector, count))


def redact_text(value: object) -> RedactionResult:
    redacted = str(value)
    findings: List[RedactionFinding] = []
    for detector in DETECTORS:
        redacted, count = detector.regex.subn(detector.token, redacted)
        if count > 0:
            findings.append(RedactionFinding(detector.name, count))

    patterns = [
        ("password", re.compile(r"((?:\"password\"|'password')\s*:\s*)([\"'])(.*?)\2", re.IGNORECASE), r"\1\2[REDACTED:password]\2"),
        ("password", re.compile(r"(\bpassword\b\s*[:=]\s*)([\"'])(.*?)\2", re.IGNORECASE), r"\1\2[REDACTED:password]\2"),
        ("password", re.compile(r"(\bpassword\b\s*[:=]\s*)([\"']?)[^\s\"'`,;}]+", re.IGNORECASE), r"\1[REDACTED:password]"),
        ("authorization", re.compile(r"((?:\"|')(?:authorization|proxy-authorization)(?:\"|')\s*:\s*)([\"'])(.*?)\2", re.IGNORECASE), r"\1\2[REDACTED:authorization]\2"),
        ("authorization", re.compile(r"(\b(?:authorization|proxy[_-]authorization)\b\s*[:=]\s*)([\"']?)[^\s\"'`,;}]+(?:\s+[^\s\"'`,;}]+)?", re.IGNORECASE), r"\1[REDACTED:authorization]"),
        ("secret_assignment", re.compile(r"((?:\"|')[A-Za-z0-9_]*(?:secret|token|api[_-]?key|access[_-]?key|database_url|db_url|private[_-]?key)[A-Za-z0-9_]*(?:\"|')\s*:\s*)([\"'])(.*?)\2", re.IGNORECASE), r"\1\2[REDACTED:secret_assignment]\2"),
        ("secret_assignment", re.compile(r"((?:\b(?:const|let|var)\s+)?\b[A-Za-z0-9_]*(?:secret|token|api[_-]?key|access[_-]?key|database_url|db_url|private[_-]?key)[A-Za-z0-9_]*\b\s*[:=]\s*)([\"'])(.*?)\2", re.IGNORECASE), r"\1\2[REDACTED:secret_assignment]\2"),
        ("secret_assignment", re.compile(r"((?:\b(?:const|let|var)\s+)?\b[A-Za-z0-9_]*(?:secret|token|api[_-]?key|access[_-]?key|database_url|db_url|private[_-]?key)[A-Za-z0-9_]*\b\s*[:=]\s*)[^\s\"'`,;}]+", re.IGNORECASE), r"\1[REDACTED:secret_assignment]"),
    ]
    for detector, pattern, replacement in patterns:
        redacted, count = pattern.subn(replacement, redacted)
        if count > 0:
            _record(findings, detector, count)
    return RedactionResult(redacted, findings)
