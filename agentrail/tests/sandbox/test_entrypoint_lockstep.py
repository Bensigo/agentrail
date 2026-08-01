"""Lockstep pin (Arc C §6): the bash run.json parser mirrors native_runner.

agentrail/docker/runner/entrypoint.sh duplicates _result_from_run_json in a
python heredoc. #1267's refusal branch never made it there — a refusal in the
container path fell through to 'red' and burned retries. Pin the branch AND
the byte-exact prefix so the two parsers cannot drift silently again.
"""
from pathlib import Path

from agentrail.sandbox.native_runner import HOSTED_REFUSAL_PREFIX

_ENTRYPOINT = Path(__file__).resolve().parents[2] / "docker" / "runner" / "entrypoint.sh"


def test_entrypoint_parses_refusal_marker_with_exact_prefix():
    text = _ENTRYPOINT.read_text()
    assert 'data.get("refusal")' in text
    assert f'"{HOSTED_REFUSAL_PREFIX}"' in text or f"'{HOSTED_REFUSAL_PREFIX}'" in text


def test_entrypoint_refusal_branch_precedes_gate_read():
    text = _ENTRYPOINT.read_text()
    assert text.index('data.get("refusal")') < text.index('data.get("objectiveGate")')
