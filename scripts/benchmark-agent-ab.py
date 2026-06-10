#!/usr/bin/env python3
"""Agent A/B benchmark: same tasks through a real agent WITH vs WITHOUT AgentRail.

Runs each task twice (arm A = plain agent; arm B = agent + AgentRail MCP),
repeated N times, and records total tokens / context-found / latency so the
"fewer tokens than Claude/Codex" claim can be measured honestly.

See docs/benchmarks/agent-ab-protocol.md for methodology and fairness rules.

This harness shells out to YOUR agent CLI — it needs your agent + API key. It
never fabricates numbers; the results file is produced only from real runs.
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def _extract_tokens(payload: Any, tokens_path: str) -> Optional[int]:
    """Sum the dotted JSON paths in tokens_path, e.g. 'usage.input+usage.output'."""
    total = 0
    found = False
    for term in tokens_path.split("+"):
        node: Any = payload
        ok = True
        for key in term.strip().split("."):
            if isinstance(node, dict) and key in node:
                node = node[key]
            else:
                ok = False
                break
        if ok and isinstance(node, (int, float)):
            total += int(node)
            found = True
    return total if found else None


def _run_agent(cmd_template: str, prompt: str, repo: str, env_extra: Dict[str, str]) -> Dict[str, Any]:
    import os

    args = [a.replace("{prompt}", prompt).replace("{repo}", repo) for a in shlex.split(cmd_template)]
    env = {**os.environ, **env_extra}
    started = time.perf_counter()
    proc = subprocess.run(args, capture_output=True, text=True, env=env, cwd=repo)
    wall_ms = (time.perf_counter() - started) * 1000
    out = proc.stdout.strip()
    parsed: Any = None
    try:
        parsed = json.loads(out)
    except Exception:
        parsed = None
    return {"stdout": out, "json": parsed, "returncode": proc.returncode, "wallMs": round(wall_ms, 1)}


def _context_found(result: Dict[str, Any], required: List[str]) -> bool:
    """Heuristic: did the run reference the required context file(s)? Override with
    a stricter check (tool-call inspection) if your agent CLI exposes it."""
    text = result.get("stdout") or ""
    return all(any(r in text for r in [req, Path(req).name]) for req in required) if required else False


# Arm B = the AgentRail arm. Default to the CLI: a pilot agent run showed the CLI
# uses fewer tokens than the MCP for the same task (MCP call overhead). The
# "one focused search, then get the lines" wording avoids over-calling.
AGENTRAIL_CLI_SUFFIX = (
    "\n\nTo locate code, use the AgentRail CLI via the shell: run"
    " `{bin} context search \"<query>\" --target .` ONCE, then"
    " `{bin} context get <path> --lines A-B --target .` for only the lines you"
    " need. Do not read whole files and do not issue many redundant searches."
)


def run_arm(arm: str, task: Dict[str, Any], prompt: str, cmd: str, tokens_path: str, env_extra: Dict[str, str], reps: int) -> Dict[str, Any]:
    runs = []
    for _ in range(reps):
        r = _run_agent(cmd, prompt, task["repo"], env_extra)
        tokens = _extract_tokens(r["json"], tokens_path) if r["json"] is not None else None
        runs.append({
            "tokens": tokens,
            "contextFound": _context_found(r, task.get("requiredContext", [])),
            "wallMs": r["wallMs"],
            "returncode": r["returncode"],
        })
    tok_vals = [x["tokens"] for x in runs if isinstance(x["tokens"], int)]
    return {
        "arm": arm,
        "runs": runs,
        "meanTokens": round(sum(tok_vals) / len(tok_vals)) if tok_vals else None,
        "contextFoundRate": round(sum(1 for x in runs if x["contextFound"]) / len(runs), 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--agent-cmd", required=True, help="Agent command template; {prompt}/{repo} substituted. Used for both arms.")
    ap.add_argument("--agentrail-bin", default="agentrail", help="Path to the agentrail CLI for arm B's instruction.")
    ap.add_argument("--tokens-path", required=True, help="JSON path(s) to token usage, e.g. usage.input+usage.output.")
    ap.add_argument("--repetitions", type=int, default=3)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    tasks = json.loads(Path(args.tasks).read_text(encoding="utf-8"))["tasks"]
    cli_suffix = AGENTRAIL_CLI_SUFFIX.format(bin=args.agentrail_bin)

    rows = []
    for task in tasks:
        a = run_arm("A (plain)", task, task["prompt"], args.agent_cmd, args.tokens_path, {}, args.repetitions)
        b = run_arm("B (AgentRail CLI)", task, task["prompt"] + cli_suffix, args.agent_cmd, args.tokens_path, {}, args.repetitions)
        rows.append({"task": task["name"], "A": a, "B": b})

    a_tok = [r["A"]["meanTokens"] for r in rows if r["A"]["meanTokens"]]
    b_tok = [r["B"]["meanTokens"] for r in rows if r["B"]["meanTokens"]]
    headline = "_Run incomplete — token usage was not captured. Verify --tokens-path against your agent's JSON._"
    if a_tok and b_tok:
        at, bt = sum(a_tok), sum(b_tok)
        delta = f"-{round((at - bt) / at * 100)}%" if at else "n/a"
        headline = f"Total tokens — plain agent: **{at:,}** · AgentRail: **{bt:,}** ({delta})."

    L = [
        "# Agent A/B Benchmark — AgentRail vs plain agent",
        "",
        f"Tasks: {len(tasks)} · repetitions: {args.repetitions} · arm A = plain agent, arm B = agent + AgentRail MCP.",
        "See `docs/benchmarks/agent-ab-protocol.md` for methodology and caveats.",
        "",
        headline,
        "",
        "| task | A mean tokens | B mean tokens | A context-found | B context-found |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        L.append(f"| {r['task']} | {r['A']['meanTokens']} | {r['B']['meanTokens']} | {r['A']['contextFoundRate']} | {r['B']['contextFoundRate']} |")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
