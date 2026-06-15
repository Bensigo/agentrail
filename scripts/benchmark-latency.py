#!/usr/bin/env python3
"""Cold vs warm context-query latency benchmark (#742 / M020).

Measures wall-clock latency of `agentrail context query` two ways on a target
repo: cold (no daemon — build/load per query) and warm (daemon serving the index
from memory). Writes a results doc with median + p95 over N queries.

Run:
  AGENTRAIL_ALLOW_SOURCE_RUN=1 PYTHONPATH=. python3 scripts/benchmark-latency.py \
      --target . --out docs/benchmarks/results/latency-latest.md
"""
from __future__ import annotations

import argparse
import statistics
import subprocess
import time
from pathlib import Path

QUERIES = [
    "query_context",
    "build context pack",
    "cost_for pricing",
    "review gate evaluate",
    "afk runner claim issue",
    "daemon serve warm query",
]


def _run(args: list[str], target: str) -> None:
    subprocess.run(args, cwd=target, capture_output=True, text=True)


def _time_query(q: str, target: str) -> float:
    t0 = time.perf_counter()
    subprocess.run(
        ["agentrail", "context", "query", q, "--json"],
        cwd=target, capture_output=True, text=True,
    )
    return (time.perf_counter() - t0) * 1000.0  # ms


def _stats(samples: list[float]) -> tuple[float, float]:
    s = sorted(samples)
    median = statistics.median(s)
    p95 = s[max(0, int(round(0.95 * len(s))) - 1)]
    return median, p95


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=".")
    ap.add_argument("--out", required=True)
    ap.add_argument("--reps", type=int, default=3)
    args = ap.parse_args()
    target = str(Path(args.target).resolve())

    _run(["agentrail", "context", "index"], target)

    # Cold: daemon stopped, each query builds/loads.
    _run(["agentrail", "context", "daemon", "stop"], target)
    cold = [_time_query(q, target) for _ in range(args.reps) for q in QUERIES]

    # Warm: daemon serving from memory.
    _run(["agentrail", "context", "daemon", "start"], target)
    [_time_query(q, target) for q in QUERIES]  # warm-up
    warm = [_time_query(q, target) for _ in range(args.reps) for q in QUERIES]
    _run(["agentrail", "context", "daemon", "stop"], target)

    cold_med, cold_p95 = _stats(cold)
    warm_med, warm_p95 = _stats(warm)
    n = len(warm)

    md = f"""# AgentRail Context Query Latency — Benchmarks

_Measured 2026-06-15 by `scripts/benchmark-latency.py` on this repo ({Path(target).name}). {n} samples per arm ({len(QUERIES)} queries x {args.reps} reps). Wall-clock per `agentrail context query`._

| arm | median | p95 |
| --- | --- | --- |
| cold (no daemon, build/load per query) | {cold_med:.0f} ms | {cold_p95:.0f} ms |
| **warm (daemon, served from memory)** | **{warm_med:.0f} ms** | {warm_p95:.0f} ms |

- Warm queries are served by the daemon holding the parsed index, BM25 postings,
  symbol table, and call edges in memory (Context Engine v2).
- Scope: one repo, {n} samples. Latency varies with repo size and machine.
"""
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(md, encoding="utf-8")
    print(f"wrote {args.out}: cold median {cold_med:.0f}ms, warm median {warm_med:.0f}ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
