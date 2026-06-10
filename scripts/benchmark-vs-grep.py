#!/usr/bin/env python3
"""Real retrieval comparison: AgentRail context search vs grep vs ripgrep.

For each fixture (a query with known ground-truth definition file(s)), each tool
returns a set of candidate files; we score precision and recall against the
required files. grep/ripgrep return every literal match (high recall, low
precision); AgentRail returns a ranked top-K (better precision when its ranking
puts the right file first).

Usage:
  PYTHONPATH=. python3 scripts/benchmark-vs-grep.py --target /path/to/repo [--fixtures fixtures.json] [--k 10]

All three tools search the same tree. grep/ripgrep are the real binaries
(ripgrep via its bundled executable); paths are normalised to repo-relative.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Dict, List, Set

from agentrail.context.retrieval import estimate_tokens, search_context

_CLAUDE_BIN = os.environ.get("CLAUDE_CODE_EXECPATH") or "/Users/macbook/.local/bin/claude"


def _norm(paths: List[str], root: Path) -> Set[str]:
    out: Set[str] = set()
    for p in paths:
        p = p.strip()
        if not p:
            continue
        p = p[2:] if p.startswith("./") else p
        try:
            p = str(Path(p).resolve().relative_to(root))
        except (ValueError, OSError):
            pass
        out.add(p)
    return out


def grep_files(query: str, root: Path) -> Set[str]:
    r = subprocess.run(["grep", "-rlF", "--exclude-dir=.git", query, "."],
                       cwd=root, capture_output=True, text=True)
    return _norm(r.stdout.splitlines(), root)


def rg_files(query: str, root: Path) -> Set[str]:
    try:
        r = subprocess.run(["rg", "-lF", query, "."], cwd=root,
                           executable=_CLAUDE_BIN, capture_output=True, text=True, timeout=30)
        return _norm(r.stdout.splitlines(), root)
    except Exception:
        return set()


def full_file_tokens(files: Set[str], root: Path) -> int:
    """Tokens an agent burns reading every matched file in full (grep workflow)."""
    total = 0
    for f in files:
        try:
            total += estimate_tokens((root / f).read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            pass
    return total


def agentrail_files(query: str, root: Path, k: int):
    out = search_context(root, query, limit=max(k * 3, 20))
    ordered: List[str] = []
    compact_tokens = 0
    for r in out.get("results", []):
        p = r.get("path")
        if p and p not in ordered:
            ordered.append(p)
            compact_tokens += int(r.get("tokenEstimate") or 0)
        if len(ordered) >= k:
            break
    return ordered, compact_tokens


def score(retrieved: Set[str], required: Set[str]) -> Dict[str, float]:
    hit = retrieved & required
    recall = len(hit) / len(required) if required else 0.0
    precision = len(hit) / len(retrieved) if retrieved else 0.0
    return {"recall": round(recall, 3), "precision": round(precision, 3), "returned": len(retrieved)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", required=True)
    ap.add_argument("--fixtures")
    ap.add_argument("--k", type=int, default=10)
    args = ap.parse_args()
    root = Path(args.target).resolve()

    if args.fixtures:
        fixtures = json.loads(Path(args.fixtures).read_text())["fixtures"]
    else:
        fixtures = DEFAULT_EXPRESS_FIXTURES

    rows = []
    agg = {t: {"recall": 0.0, "precision": 0.0} for t in ("grep", "ripgrep", "agentrail")}
    tok = {"grep_full": 0, "rg_full": 0, "agentrail_compact": 0}
    for fx in fixtures:
        q = fx["query"]
        required = set(fx["required"])
        grep_matched = grep_files(q, root)
        rg_matched = rg_files(q, root)
        g = score(grep_matched, required)
        rgs = score(rg_matched, required)
        ar_list, ar_tokens = agentrail_files(q, root, args.k)
        a = score(set(ar_list), required)
        tok["grep_full"] += full_file_tokens(grep_matched, root)
        tok["rg_full"] += full_file_tokens(rg_matched, root)
        tok["agentrail_compact"] += ar_tokens
        # Ranking quality: rank of the first required file (1=best, 0=not in top-K).
        a["firstRank"] = next((i + 1 for i, p in enumerate(ar_list) if p in required), 0)
        a["p_at_1"] = 1.0 if ar_list and ar_list[0] in required else 0.0
        rows.append({"query": q, "required": sorted(required), "grep": g, "ripgrep": rgs,
                     "agentrail": a, "agentrailTopK": ar_list})
        for t, m in (("grep", g), ("ripgrep", rgs), ("agentrail", a)):
            agg[t]["recall"] += m["recall"] / len(fixtures)
            agg[t]["precision"] += m["precision"] / len(fixtures)
        agg["agentrail"].setdefault("p_at_1", 0.0)
        agg["agentrail"]["p_at_1"] += a["p_at_1"] / len(fixtures)

    print(f"\nReal retrieval benchmark — AgentRail vs grep vs ripgrep")
    print(f"target: {root}   fixtures: {len(fixtures)}   K(agentrail)={args.k}\n")
    hdr = f"{'query':18} | {'required':18} | {'grep R/P(n)':14} | {'rg R/P(n)':14} | {'AR R/P(n)':14} | {'AR rank':7}"
    print(hdr); print("-" * len(hdr))
    for r in rows:
        def cell(m):
            return f"{m['recall']:.2f}/{m['precision']:.2f}({m['returned']})"
        ar = r["agentrail"]
        print(f"{r['query'][:18]:18} | {','.join(r['required'])[:18]:18} | {cell(r['grep']):14} | {cell(r['ripgrep']):14} | {cell(ar):14} | #{ar['firstRank']}")
    print("-" * len(hdr))
    for t in ("grep", "ripgrep", "agentrail"):
        extra = f"  precision@1={agg[t].get('p_at_1', 0.0):.3f}" if t == "agentrail" else ""
        print(f"AVG {t:10} recall={agg[t]['recall']:.3f}  set-precision={agg[t]['precision']:.3f}{extra}")
    print()
    def pct(new, old):
        return f"-{round((old - new) / old * 100)}%" if old else "n/a"
    print("Token cost to obtain the context (sum over fixtures):")
    print(f"  grep + read matched files in full : {tok['grep_full']:>8} tok")
    print(f"  ripgrep + read matched files full : {tok['rg_full']:>8} tok")
    print(f"  AgentRail compact snippets        : {tok['agentrail_compact']:>8} tok  "
          f"({pct(tok['agentrail_compact'], tok['grep_full'])} vs grep, {pct(tok['agentrail_compact'], tok['rg_full'])} vs rg)")
    print("\nNote: grep/ripgrep are unordered literal matchers (no rank). AgentRail returns a ranked top-K;")
    print("'AR rank' is the rank of the definition file. Set-precision penalises AgentRail's fixed K vs")
    print("grep/rg returning only literal matches — precision@1 measures whether the definition ranks first.")
    return 0


DEFAULT_EXPRESS_FIXTURES = [
    {"query": "res.json", "required": ["lib/response.js"]},
    {"query": "res.sendFile", "required": ["lib/response.js"]},
    {"query": "req.accepts", "required": ["lib/request.js"]},
    {"query": "app.listen", "required": ["lib/application.js"]},
    {"query": "createApplication", "required": ["lib/express.js"]},
    {"query": "function View", "required": ["lib/view.js"]},
]


if __name__ == "__main__":
    raise SystemExit(main())
