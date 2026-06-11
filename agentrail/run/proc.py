"""Process helpers for agentrail run.

Ports sanitized_agent_exec and portable_timeout from scripts/lib/timeout.sh.
"""
from __future__ import annotations
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import List, Optional

STRIP_ENV_VARS = (
    "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH", "CLAUDE_EFFORT",
    "AI_AGENT", "CODEX_SESSION", "CODEX_SANDBOX", "CURSOR_SESSION", "CURSOR_AGENT",
)


def sanitized_env() -> dict:
    """os.environ minus the agent-session vars (mirror sanitized_agent_exec)."""
    return {k: v for k, v in os.environ.items() if k not in STRIP_ENV_VARS}


def run_with_timeout(argv: List[str], *, cwd: Path, timeout: int, output_file: Path,
                     stdin_text: Optional[str] = None, env: Optional[dict] = None) -> int:
    """Run argv, tee combined stdout+stderr to BOTH the live console and output_file,
    enforce a wall-clock timeout. Return the exit code, or 124 on timeout
    (mirrors portable_timeout's 124 convention).

    Uses a reader thread to drain stdout so that proc.wait(timeout=timeout) is
    reached promptly even when the child produces no output (e.g. a hanging sleep).
    """
    env = env if env is not None else sanitized_env()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        argv, cwd=str(cwd), env=env,
        stdin=subprocess.PIPE if stdin_text is not None else None,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if stdin_text is not None and proc.stdin is not None:
        try:
            proc.stdin.write(stdin_text)
            proc.stdin.close()
        except BrokenPipeError:
            pass

    chunks: List[str] = []

    def _drain() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            chunks.append(line)
            sys.stdout.write(line)

    reader = threading.Thread(target=_drain, daemon=True)
    reader.start()

    try:
        proc.wait(timeout=timeout)
        reader.join()
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        reader.join()
        rc = 124
    finally:
        output_file.write_text("".join(chunks))

    return rc
