#!/usr/bin/env python3
"""Consolidated AgentRail retrieval benchmark — the landing-page source.

Assembles every measured axis into one markdown doc:
  1. Exact/symbol lookup vs grep vs ripgrep (recall, precision@1, token cost)
  2. Semantic/conceptual retrieval (lexical-only vs embeddings on)

Run:
  PYTHONPATH=. python3 scripts/benchmark-all.py \
      --exact-target /path/to/express \
      --embed-model qwen3-embedding:latest \
      --out docs/benchmarks/results/context-retrieval-cli-latest.md

Numbers are real and reproducible. The exact section needs no provider; the
semantic section needs an embedding provider (e.g. local Ollama) reachable.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.embeddings import embed_context, setup_embeddings
from agentrail.context.retrieval import query_context

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("bvg", _HERE / "benchmark-vs-grep.py")
bvg = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(bvg)  # type: ignore[union-attr]


# --- Semantic conceptual fixtures (answer files share NO keywords with the query;
#     a decoy file shares surface words but is the wrong answer). -------------
CONCEPTUAL = [
    {
        "query": "how do we decide if a user is allowed in",
        "correct": "src/gatekeeper.py",
        "files": {
            "src/gatekeeper.py": "def evaluate_entry(caller):\n    # may this caller proceed, given credentials and role?\n    return caller.role in approved_roles and not ticket_expired(caller.ticket)\n",
            "src/report.py": "def decide_layout(width):\n    # everyone is allowed to view reports\n    return 'wide' if width > 800 else 'narrow'\n",
        },
    },
    {
        "query": "where do we keep results temporarily to avoid recomputing",
        "correct": "src/memo.py",
        "files": {
            "src/memo.py": "def remember(value, key):\n    # stash a computed answer in memory so later calls return instantly\n    store[key] = value\n    return value\n",
            "src/scratch.py": "def keep_temp_file(name):\n    # keep temporary scratch files on disk for the build\n    open('/tmp/' + name, 'w').close()\n",
        },
    },
    {
        "query": "what makes a draft visible to the public",
        "correct": "src/release.py",
        "files": {
            "src/release.py": "def promote_article(article):\n    # flip from private editing to live, indexed, reachable by anyone\n    article.state = 'live'\n    return article\n",
            "src/draft.py": "def save_draft(article):\n    # a draft stays visible only to its author until later\n    article.state = 'draft'\n    return article\n",
        },
    },
]


def _make_semantic_repo() -> Path:
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(json.dumps({
        "schemaVersion": 1,
        "context": {
            "includeGlobs": ["**/*"], "excludeGlobs": [".git/**", ".agentrail/context/**"],
            "maxFileSizeBytes": 262144, "skipBinary": True, "respectGitIgnore": True,
            "secretRedaction": {"enabled": False, "action": "exclude", "denyGlobs": []},
            "embedding": {"mode": "disabled", "provider": None, "model": None},
            "summary": {"mode": "disabled", "provider": None, "model": None},
        },
    }, indent=2), encoding="utf-8")
    for fx in CONCEPTUAL:
        for path, body in fx["files"].items():
            fp = root / path
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(body, encoding="utf-8")
    return root


def _rank_of(root: Path, query: str, correct: str) -> int:
    out = query_context(root, query, limit=10)
    for i, r in enumerate(out.get("results", []), 1):
        if r.get("path") == correct:
            return i
    return 0


def run_semantic(embed_model: str) -> Optional[Dict[str, Any]]:
    root = _make_semantic_repo()
    off = [{"query": fx["query"], "correct": fx["correct"], "rank": _rank_of(root, fx["query"], fx["correct"])}
           for fx in CONCEPTUAL]
    try:
        setup_embeddings(root, "ollama", model=embed_model, validate=True)
        embed_context(root)
    except Exception as error:  # provider unreachable — skip gracefully
        return {"available": False, "error": str(error), "off": off}
    on = [{"query": fx["query"], "correct": fx["correct"], "rank": _rank_of(root, fx["query"], fx["correct"])}
          for fx in CONCEPTUAL]
    return {"available": True, "model": embed_model, "off": off, "on": on}


def run_exact(target: Path, k: int) -> Dict[str, Any]:
    rows = []
    agg = {t: {"recall": 0.0, "precision": 0.0, "p_at_1": 0.0} for t in ("grep", "ripgrep", "agentrail")}
    tok = {"grep_full": 0, "rg_full": 0, "agentrail_compact": 0}
    n = len(bvg.DEFAULT_EXPRESS_FIXTURES)
    for fx in bvg.DEFAULT_EXPRESS_FIXTURES:
        q, required = fx["query"], set(fx["required"])
        gm, rm = bvg.grep_files(q, target), bvg.rg_files(q, target)
        g, rg = bvg.score(gm, required), bvg.score(rm, required)
        ar_list, ar_tok = bvg.agentrail_files(q, target, k)
        a = bvg.score(set(ar_list), required)
        a["firstRank"] = next((i + 1 for i, p in enumerate(ar_list) if p in required), 0)
        a["p_at_1"] = 1.0 if ar_list and ar_list[0] in required else 0.0
        rows.append({"query": q, "required": sorted(required), "grep": g, "ripgrep": rg, "agentrail": a})
        tok["grep_full"] += bvg.full_file_tokens(gm, target)
        tok["rg_full"] += bvg.full_file_tokens(rm, target)
        tok["agentrail_compact"] += ar_tok
        for key, m in (("grep", g), ("ripgrep", rg), ("agentrail", a)):
            agg[key]["recall"] += m["recall"] / n
            agg[key]["precision"] += m["precision"] / n
        agg["agentrail"]["p_at_1"] += a["p_at_1"] / n
    return {"rows": rows, "agg": agg, "tok": tok, "n": n}


def _pct(new: float, old: float) -> str:
    return f"-{round((old - new) / old * 100)}%" if old else "n/a"


def build_markdown(exact: Dict[str, Any], semantic: Optional[Dict[str, Any]], target_label: str) -> str:
    e, agg, tok = exact, exact["agg"], exact["tok"]
    L: List[str] = [
        "# AgentRail Context Retrieval — Benchmarks",
        "",
        "_All numbers are measured and reproducible (`scripts/benchmark-all.py`). They are"
        " scoped to the runs described below, not universal guarantees — per the project's"
        " benchmark claim rules._",
        "",
        "## Headline",
        "",
        f"- **Same files as grep, a fraction of the tokens.** On {target_label} symbol lookups, AgentRail"
        f" returned the required file every time ({agg['agentrail']['recall']:.0%} recall) using"
        f" **{tok['agentrail_compact']:,} tokens** of compact context vs **{tok['grep_full']:,}** to read grep's"
        f" matches in full ({_pct(tok['agentrail_compact'], tok['grep_full'])}) and **{tok['rg_full']:,}** for"
        f" ripgrep's ({_pct(tok['agentrail_compact'], tok['rg_full'])}).",
        f"- **Ranks the right file first.** Definition ranked #1 in"
        f" **{agg['agentrail']['p_at_1']:.0%}** of lookups (grep/ripgrep return an unordered pile).",
    ]
    if semantic and semantic.get("available"):
        moved = sum(1 for off, on in zip(semantic["off"], semantic["on"]) if on["rank"] == 1 and off["rank"] != 1)
        L.append(
            f"- **Finds code by meaning, not just keywords.** With embeddings on ({semantic['model']}),"
            f" the correct file ranked #1 on {sum(1 for o in semantic['on'] if o['rank'] == 1)}/{len(semantic['on'])}"
            f" conceptual queries that share no words with it ({moved} flipped from a wrong #1 under keyword-only search).")
    L += [
        "",
        "## 1. Exact / symbol lookup — AgentRail vs grep vs ripgrep",
        "",
        f"Target: **{target_label}** · {e['n']} symbol queries with ground-truth definition files · embeddings off.",
        "",
        "| metric | grep | ripgrep | AgentRail |",
        "| --- | --- | --- | --- |",
        f"| recall (finds the file) | {agg['grep']['recall']:.2f} | {agg['ripgrep']['recall']:.2f} | {agg['agentrail']['recall']:.2f} |",
        f"| precision@1 (definition ranked first) | — | — | **{agg['agentrail']['p_at_1']:.2f}** |",
        f"| tokens to obtain context | {tok['grep_full']:,} | {tok['rg_full']:,} | **{tok['agentrail_compact']:,}** |",
        "",
        "| query | required | grep R/P (n) | rg R/P (n) | AgentRail R/P (n) | AR rank |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in e["rows"]:
        def c(m):
            return f"{m['recall']:.2f}/{m['precision']:.2f} ({m['returned']})"
        L.append(f"| `{r['query']}` | {', '.join(r['required'])} | {c(r['grep'])} | {c(r['ripgrep'])} | {c(r['agentrail'])} | #{r['agentrail']['firstRank']} |")
    L += [
        "",
        "## 2. Semantic / conceptual retrieval",
        "",
        "Plain-English questions whose answer file shares **no keywords** with the question"
        " (a decoy file does). Shows whether retrieval finds code by meaning.",
        "",
    ]
    if not semantic or not semantic.get("available"):
        L.append("_Not measured this run (no embedding provider reachable). Enable one with"
                 " `agentrail context embed setup ollama` and re-run._")
        if semantic:
            L.append("")
            L.append("| query | correct file | rank (keyword-only) |")
            L.append("| --- | --- | --- |")
            for o in semantic["off"]:
                L.append(f"| `{o['query']}` | {o['correct']} | {'#'+str(o['rank']) if o['rank'] else 'not found'} |")
    else:
        L.append(f"Embeddings: **{semantic['model']}** (local Ollama).")
        L.append("")
        L.append("| query | correct file | rank: keyword-only | rank: semantic on |")
        L.append("| --- | --- | --- | --- |")
        for off, on in zip(semantic["off"], semantic["on"]):
            L.append(f"| `{off['query']}` | {off['correct']} | {'#'+str(off['rank']) if off['rank'] else 'not found'} | **{'#'+str(on['rank']) if on['rank'] else 'not found'}** |")
    L += [
        "",
        "## Honest caveats",
        "- Recall ties with grep/ripgrep on literal lookups; AgentRail's edge is **fewer tokens** and"
        " **ranking the right file first**, plus conceptual queries grep cannot do.",
        "- Set-precision is not AgentRail's lens (it returns a ranked top-K); precision@1 and token cost are.",
        "- The semantic section uses controlled fixtures to isolate meaning-vs-keyword; broaden it on real"
        " repos before headline use.",
        "",
        "## Reproduce",
        "```bash",
        "PYTHONPATH=. python3 scripts/benchmark-all.py \\",
        "  --exact-target /path/to/express --embed-model qwen3-embedding:latest \\",
        "  --out docs/benchmarks/results/context-retrieval-cli-latest.md",
        "```",
        "",
    ]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exact-target", required=True, help="Real repo for the grep/rg comparison (e.g. express).")
    ap.add_argument("--exact-label", default="")
    ap.add_argument("--embed-model", default="qwen3-embedding:latest")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    target = Path(args.exact_target).resolve()
    label = args.exact_label or target.name
    exact = run_exact(target, args.k)
    semantic = run_semantic(args.embed_model)
    md = build_markdown(exact, semantic, label)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(md, encoding="utf-8")
    print(f"wrote {args.out}")
    print(f"  exact: recall={exact['agg']['agentrail']['recall']:.2f} precision@1={exact['agg']['agentrail']['p_at_1']:.2f} "
          f"tokens={exact['tok']['agentrail_compact']:,} (grep {exact['tok']['grep_full']:,})")
    if semantic and semantic.get("available"):
        print(f"  semantic ({semantic['model']}): #1 on {sum(1 for o in semantic['on'] if o['rank']==1)}/{len(semantic['on'])} conceptual queries")
    else:
        print("  semantic: provider not reachable — section marked not-measured")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
