"""
Native PR-review engine — port of ``templates/scripts/review-pr``.

This module builds the review prompt (with the machine-readable JSON contract
preserved byte-faithfully), invokes the review agent (codex / claude), and
validates the machine-readable output. It is the implementation behind
``agentrail internal review-pr`` (the legacy bash script and the
``AGENTRAIL_NATIVE_REVIEW`` escape hatch were removed in milestone M3 / #430).

CRITICAL invariant: the machine-readable contract instructs the agent to emit a
``BEGIN_REVIEW_FIX_ISSUES_JSON … END_REVIEW_FIX_ISSUES_JSON`` block containing a
JSON object with ``fix_issues`` and ``memory_suggestions`` arrays EVEN WHEN BOTH
ARE EMPTY. ``agentrail.afk.review.extract_json_block`` parses it; if absent, AFK
fails the review. Do not drop or reword that instruction.
"""
from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Optional

from agentrail.afk.review import extract_json_block
from agentrail.run.proc import run_with_timeout, sanitized_env


class ReviewError(Exception):
    """Raised for review setup / validation failures (mirrors the script's die())."""


def _resolve_doc(repo_root: Path, rel: str) -> Optional[Path]:
    """Resolve a doc path relative to repo_root, with templates/ fallback.

    Mirrors the script's behavior: prefer ``docs/agents/...`` but fall back to
    ``agentrail/templates/docs/agents/...`` when the project hasn't installed
    the doc (only reachable when *repo_root* is the agentrail source repo
    itself, e.g. dogfooding AFK on agentrail's own PRs — an arbitrary target
    project without an installed doc has no agentrail/templates/ tree either).
    """
    primary = repo_root / rel
    if primary.is_file():
        return primary
    fallback = repo_root / "agentrail" / "templates" / rel
    if fallback.is_file():
        return fallback
    return None


def build_review_prompt(
    pr: str,
    title: str,
    url: str,
    machine_readable: bool,
    repo_root: Path,
) -> str:
    """Port of the script's ``review_prompt``.

    Inlines ``docs/agents/pr-review.md`` always, and
    ``docs/agents/github-pr-reviewer.md`` when ``machine_readable`` — each with a
    ``templates/docs/agents/`` fallback. Includes the machine-readable JSON
    contract instruction verbatim from the script.
    """
    repo_root = Path(repo_root)
    prompt_file = _resolve_doc(repo_root, "docs/agents/pr-review.md")
    if prompt_file is None:
        raise ReviewError(
            "missing PR review instructions: docs/agents/pr-review.md or "
            "templates/docs/agents/pr-review.md"
        )

    machine_prompt_file: Optional[Path] = None
    if machine_readable:
        machine_prompt_file = _resolve_doc(repo_root, "docs/agents/github-pr-reviewer.md")
        if machine_prompt_file is None:
            raise ReviewError(
                "missing GitHub PR reviewer contract: docs/agents/github-pr-reviewer.md "
                "or templates/docs/agents/github-pr-reviewer.md"
            )

    # The path the script reports as the contract source is repo-root-relative.
    machine_prompt_rel = ""
    if machine_prompt_file is not None:
        try:
            machine_prompt_rel = str(machine_prompt_file.relative_to(repo_root))
        except ValueError:
            machine_prompt_rel = str(machine_prompt_file)

    # Bash command substitution ``$(cat file)`` strips trailing newlines, then
    # the heredoc adds exactly one. Mirror that so the native prompt is
    # byte-faithful to the legacy script.
    pr_review_body = prompt_file.read_text().rstrip("\n")

    parts: list[str] = []
    parts.append(
        f"Review exactly one pull request: #{pr}.\n"
        f"\n"
        f"Pull request title: {title}\n"
        f"Pull request URL: {url}\n"
        f"\n"
        f"Use the review instructions below:\n"
        f"\n"
        f"{pr_review_body}\n"
    )

    if machine_prompt_file is not None:
        contract_body = machine_prompt_file.read_text().rstrip("\n")
        parts.append(
            f"\n"
            f"Use the machine-readable GitHub PR reviewer contract below. You "
            f"must include the marked JSON block with both `fix_issues` and "
            f"`memory_suggestions` arrays in the final output, even when both "
            f"arrays are empty:\n"
            f"\n"
            f"Machine-readable contract source: {machine_prompt_rel}\n"
            f"\n"
            f"{contract_body}\n"
        )

    parts.append(
        f"\n"
        f"Repo-specific instructions:\n"
        f"\n"
        f"- Start from a clean checkout of the pull request head branch.\n"
        f"- Compare against the pull request base branch.\n"
        f"- Read the PR body, linked issue, milestone, PRD, architecture "
        f"baseline, and agent docs.\n"
        f"- Run agentrail memory recall for the PR title, linked issue, and key "
        f"terms when that command is available.\n"
        f"- Treat project memory as advisory; verify it against current code, "
        f"docs, issue, PRD, and ADRs.\n"
        f"- Do not edit files.\n"
        f"- Do not commit, push, close, or merge anything.\n"
        f"- Return findings first, ordered by severity.\n"
    )

    return "".join(parts)


def validate_machine_readable_output(path: Path) -> None:
    """Port of ``validate_machine_readable_review_output``.

    Raises ReviewError if the output file is missing/empty, lacks the
    BEGIN/END JSON block, or the block is not an object with ``fix_issues`` and
    ``memory_suggestions`` arrays. Reuses ``afk.review.extract_json_block`` (the
    same parser AFK uses) rather than reimplementing it.
    """
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        raise ReviewError(
            f"machine-readable review output is missing or empty: {path}"
        )

    text = path.read_text()
    if "BEGIN_REVIEW_FIX_ISSUES_JSON" not in text:
        raise ReviewError(
            f"machine-readable review output missing BEGIN_REVIEW_FIX_ISSUES_JSON "
            f"block: {path}"
        )

    data = extract_json_block(text)
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("fix_issues"), list)
        or not isinstance(data.get("memory_suggestions"), list)
    ):
        raise ReviewError(
            f"machine-readable review output must include fix_issues and "
            f"memory_suggestions arrays: {path}"
        )


def _agent_timeout() -> int:
    """Honor AGENTRAIL_AGENT_TIMEOUT with a generous default.

    The legacy script imposed NO timeout, so reviews could run for a long time.
    We add a bound (so a hung agent doesn't wedge the AFK loop) but default it
    generously and let operators override it.
    """
    raw = os.environ.get("AGENTRAIL_AGENT_TIMEOUT")
    try:
        return int(raw) if raw else 3600
    except ValueError:
        return 3600


def run_review(
    engine: str,
    base: str,
    pr: str,
    prompt: str,
    output: Optional[str],
    timeout: Optional[int] = None,
    *,
    cwd: Optional[Path] = None,
) -> int:
    """Port of ``run_codex_review`` / ``run_claude_review``.

    codex: ``codex exec review --base <base> [-o output] [REVIEW_CODEX_ARGS]``
           with the prompt on stdin (note: the dedicated ``exec review``
           subcommand, NOT ``codex exec -``).
    claude: ``bash -lc "claude -p --allowedTools Bash,Read"`` with the prompt on
            stdin; output tee'd to the file.

    Runs via ``run_with_timeout`` + ``sanitized_env`` (same stripped vars as the
    script's ``sanitized_agent_exec``). Returns the agent exit code (124 on
    timeout, per run_with_timeout's convention).
    """
    timeout = timeout if timeout is not None else _agent_timeout()
    cwd = Path(cwd) if cwd is not None else Path.cwd()

    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)

    if engine == "codex":
        argv = ["codex", "exec", "review", "--base", base]
        if output:
            argv += ["-o", output]
        extra = os.environ.get("REVIEW_CODEX_ARGS", "")
        if extra.strip():
            argv += shlex.split(extra)
        # run_with_timeout tees combined stdout+stderr to output_file as well;
        # when codex writes the final message via -o, we still capture the run
        # log. To preserve the script's contract (the review final message in
        # `output`), codex's own -o handling owns the file. We point
        # run_with_timeout's tee at the same path only when codex is NOT given
        # -o; otherwise we tee to a sibling log so we don't clobber -o output.
        if output:
            tee_target = Path(output).with_suffix(Path(output).suffix + ".log")
        else:
            tee_target = cwd / ".agentrail-review.log"
        return run_with_timeout(
            argv, cwd=cwd, timeout=timeout, output_file=tee_target,
            stdin_text=prompt, env=sanitized_env(),
        )

    if engine == "claude":
        # claude prints the final message to stdout; the script tee'd stdout+stderr
        # into the output file. run_with_timeout already tees combined output to
        # output_file, so pointing it at `output` reproduces the tee behavior.
        argv = ["bash", "-lc", "claude -p --allowedTools Bash,Read"]
        tee_target = Path(output) if output else (cwd / ".agentrail-review.log")
        return run_with_timeout(
            argv, cwd=cwd, timeout=timeout, output_file=tee_target,
            stdin_text=prompt, env=sanitized_env(),
        )

    raise ReviewError(f"unsupported review engine: {engine}")
