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


DETECTORS = [
    Detector("private_key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[REDACTED:private_key]"),
    Detector("api_key", re.compile(r"\bsk-[A-Za-z0-9_-]{10,}\b"), "[REDACTED:api_key]"),
    Detector("token", re.compile(r"\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b"), "[REDACTED:token]"),
    Detector("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED:aws_access_key]"),
    Detector("database_url", re.compile(r"\b(?:postgres|postgresql|mysql|redis|mongodb)://[^\s\"'`<>]+", re.IGNORECASE), "[REDACTED:database_url]"),
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
