from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

from agentrail.context.embeddings import embed_context, setup_embeddings
from agentrail.context.benchmark import format_benchmark_summary, run_benchmark
from agentrail.context.evaluation import evaluate_retrieval, format_evaluation_report
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, explain_context_pack, show_context_pack
from agentrail.context.retrieval import compute_tokens_saved, get_file_lines, get_file_symbol, query_context, search_context
from agentrail.context.sources import inventory_sources


def _resolve_target(value: str | None) -> Path:
    return Path(value or ".").resolve()


def _touch_context_marker(target: Path) -> None:
    """Mark that context retrieval ran this session (#519).

    The context-first PreToolUse hook gates broad grep on this marker, so every
    ``context query`` / ``context search`` writes it. Best-effort: never fail a
    retrieval just because the marker could not be written.
    """
    try:
        marker = target / ".agentrail" / "tmp" / "context-queried"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        pass


def _parse_target(args: List[str]) -> Tuple[Path, List[str]]:
    target: str | None = None
    remaining: List[str] = []
    index = 0
    while index < len(args):
        if args[index] == "--target":
            if index + 1 >= len(args) or args[index + 1].startswith("--"):
                raise SystemExit("--target requires a directory")
            target = args[index + 1]
            index += 2
        else:
            remaining.append(args[index])
            index += 1
    return _resolve_target(target), remaining


def _print_json(value: object) -> None:
    print(json.dumps(value, indent=2))


def _usage() -> str:
    return """Usage:
  agentrail init [--target DIR] [--force] [--github-labels]
  agentrail install [--target DIR] [--force] [--github-labels]
  agentrail upgrade [--target DIR] [--force]
  agentrail doctor [--target DIR]
  agentrail status [--target DIR]
  agentrail context sources [--target DIR]
  agentrail context index [--target DIR]
  agentrail context embed [--target DIR]
  agentrail context embed setup (ollama|openai|custom|disable) [--model M] [--base-url URL] [--api-key-env VAR] [--command CMD] [--name N] [--no-validate] [--target DIR] [--json]
  agentrail context query "<task>" [--target DIR] [--json] [--limit N]
  agentrail context search "<query>" [--target DIR] [--json] [--limit N]
  agentrail context get PATH (--lines A-B | --symbol NAME) [--target DIR] [--json]
  agentrail context evaluate FIXTURE [--target DIR] [--json]
  agentrail context benchmark FIXTURE [--target DIR] [--json]
  agentrail context build issue NUMBER --phase PHASE [--target DIR] [--json]
  agentrail context build pr NUMBER --phase review [--target DIR] [--json]
  agentrail context show PACK [--target DIR] [--json]
  agentrail context explain PACK [--target DIR] [--json]
  agentrail context savings [--target DIR] [--json]
  agentrail memory recall QUERY [--target DIR]
  agentrail memory capture KIND TITLE [--target DIR]
  agentrail skills validate [--target DIR]
  agentrail skills list [--target DIR]
  agentrail skills resolve "<task text>" [--target DIR] [--skill NAME] [--no-auto-skills]
  agentrail resume [--target DIR] [--output FILE]
  agentrail labels sync [--target DIR]
  agentrail prompt grill "<idea>" [--agent codex|claude] [--target DIR]
  agentrail prompt issue NUMBER [--agent codex|claude] [--target DIR] [--skill NAME] [--no-auto-skills]
  agentrail prompt review PR_NUMBER [--agent codex|claude] [--target DIR]
  agentrail afk [--concurrency 2] [--max-waves 20] [--base main] [--engine codex] [--afk-label afk] [--dry-run]
  agentrail cleanup [--target DIR] [--dry-run] [--merged] [--force]
  agentrail run [--agent codex|claude] [--target DIR] [--command CMD] [--log-dir DIR]
  agentrail run issue NUMBER [--agent codex|claude] [--target DIR] [--command CMD] [--log-dir DIR]

Commands:
  init      Initialize AgentRail workflow files.
  install   Install AgentRail workflow files.
  upgrade   Upgrade managed AgentRail files without overwriting local edits.
  doctor    Inspect AgentRail installation health.
  status    Print install status and current workflow state.
  context   Inspect local context engine sources.
  memory    Recall or template project memory entries.
  skills    Inspect or validate AgentRail-managed skills.
  resume    Print and write an agent handoff summary.
  labels    Sync expected GitHub labels.
  prompt    Print an agent-ready prompt without executing an agent.
  afk       Run the AFK queue/worktree loop through the AgentRail CLI.
  cleanup   Inspect or remove AgentRail-owned worktrees.
  run       Generate a bounded prompt and execute a configured agent command."""


def run_context(args: List[str]) -> int:
    kind = args[0] if args else ""
    rest = args[1:] if args else []
    try:
        if kind == "sources":
            target, remaining = _parse_target(rest)
            if remaining:
                raise SystemExit(f"Unknown option: {remaining[0]}")
            _print_json([record.to_json(include_content=False) for record in inventory_sources(target)])
            return 0
        if kind == "index":
            target, remaining = _parse_target(rest)
            no_push = "--no-push" in remaining
            remaining = [a for a in remaining if a != "--no-push"]
            if remaining:
                raise SystemExit(f"Unknown option: {remaining[0]}")
            result = build_index(target)
            _print_json(result)
            if not no_push:
                from agentrail.context.snapshot_push import load_link, push_index_snapshot
                if push_index_snapshot(target, result):
                    print("pushed index snapshot to dashboard", file=sys.stderr)
                elif load_link(target) is not None:
                    print(
                        "warning: failed to push index snapshot; repo health may stay stale",
                        file=sys.stderr,
                    )
            return 0
        if kind == "embed" and rest and rest[0] == "setup":
            preset = rest[1] if len(rest) > 1 and not rest[1].startswith("--") else ""
            if preset not in {"ollama", "openai", "custom", "disable"}:
                raise SystemExit("context embed setup requires a preset: ollama | openai | custom | disable")
            target: str | None = None
            json_output = False
            validate = True
            opts: dict[str, str] = {}
            flag_map = {"--model": "model", "--base-url": "base_url", "--api-key-env": "api_key_env", "--command": "command", "--name": "name"}
            index = 2
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]; index += 2
                elif arg == "--json":
                    json_output = True; index += 1
                elif arg == "--no-validate":
                    validate = False; index += 1
                elif arg in flag_map:
                    if index + 1 >= len(rest):
                        raise SystemExit(f"{arg} requires a value")
                    opts[flag_map[arg]] = rest[index + 1]; index += 2
                else:
                    raise SystemExit(f"Unknown context embed setup option: {arg}")
            result = setup_embeddings(_resolve_target(target), preset, validate=validate, **opts)
            if json_output:
                _print_json(result)
            else:
                if result["mode"] == "disabled":
                    print("embeddings disabled")
                else:
                    v = result.get("validation")
                    status = f"validated ({v['provider']}/{v['model']}, dim={v['dimension']})" if v else "saved (not validated)"
                    print(f"embeddings: {result['mode']} {status}")
                    print("next: agentrail context embed   # build the vectors")
            return 0
        if kind == "embed":
            target, remaining = _parse_target(rest)
            if remaining:
                raise SystemExit(f"Unknown option: {remaining[0]}")
            _print_json(embed_context(target))
            return 0
        if kind == "query":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context query requires a task string")
            query = rest[0]
            target: str | None = None
            json_output = False
            limit = 20
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                elif arg == "--limit":
                    if index + 1 >= len(rest) or not rest[index + 1].isdigit():
                        raise SystemExit("--limit requires a numeric value")
                    limit = int(rest[index + 1])
                    index += 2
                else:
                    raise SystemExit(f"Unknown context query option: {arg}")
            resolved_target = _resolve_target(target)
            _touch_context_marker(resolved_target)
            output = query_context(resolved_target, query, limit=max(1, min(100, limit)))
            if json_output:
                _print_json(output)
            else:
                print(f"query={query}")
                for item in output["results"]:
                    print(f"{item['rank']}. {item['citation']}")
                    print(f"   score={item['score']['final']} reason={item['reason']}")
                if output["excluded"]:
                    print("excluded:")
                    for item in output["excluded"]:
                        print(f"- {item['path']}: {item['reason']}")
            return 0
        if kind == "search":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context search requires a query string")
            query = rest[0]
            target: str | None = None
            json_output = False
            limit = 10
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                elif arg == "--limit":
                    if index + 1 >= len(rest) or not rest[index + 1].isdigit():
                        raise SystemExit("--limit requires a numeric value")
                    limit = int(rest[index + 1])
                    index += 2
                else:
                    raise SystemExit(f"Unknown context search option: {arg}")
            resolved_target = _resolve_target(target)
            _touch_context_marker(resolved_target)
            output = search_context(resolved_target, query, limit=max(1, min(100, limit)))
            if json_output:
                _print_json(output)
            else:
                print(f"search={query}")
                for item in output["results"]:
                    print(f"{item['rank']}. {item['path']}:{item['lineStart']}-{item['lineEnd']} (~{item['tokenEstimate']} tok)")
                    if item.get("symbol"):
                        print(f"   symbol={item['symbol']}")
                    print(f"   reason={item['reason']}")
            return 0
        if kind == "get":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context get requires a path")
            path = rest[0]
            target: str | None = None
            json_output = False
            lines_spec: str | None = None
            symbol: str | None = None
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--lines":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--lines requires a RANGE like A-B")
                    lines_spec = rest[index + 1]
                    index += 2
                elif arg == "--symbol":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--symbol requires a name")
                    symbol = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context get option: {arg}")
            if symbol and lines_spec:
                raise SystemExit("context get accepts only one of --lines or --symbol")
            if not symbol and not lines_spec:
                raise SystemExit("context get requires --lines A-B or --symbol NAME")
            if symbol:
                output = get_file_symbol(_resolve_target(target), path, symbol)
            else:
                match = re.fullmatch(r"(\d+)-(\d+)", lines_spec or "")
                if not match:
                    raise SystemExit("--lines must be a numeric range like 12-48")
                output = get_file_lines(_resolve_target(target), path, int(match.group(1)), int(match.group(2)))
            if json_output:
                _print_json(output)
            else:
                header = f"{output['path']}:{output['lineStart']}-{output['lineEnd']}"
                if output.get("symbol"):
                    header += f" ({output['symbol']})"
                print(header)
                print(output["content"])
            return 0
        if kind == "evaluate":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context evaluate requires a fixture file")
            fixture = rest[0]
            target: str | None = None
            json_output = False
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context evaluate option: {arg}")
            output = evaluate_retrieval(_resolve_target(target), Path(fixture))
            if json_output:
                _print_json(output)
            else:
                print(format_evaluation_report(output))
            return 0 if output.get("passed") else 1
        if kind == "benchmark":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context benchmark requires a fixture file")
            fixture = rest[0]
            target: str | None = None
            json_output = False
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context benchmark option: {arg}")
            root = _resolve_target(target)
            output = run_benchmark(root, Path(fixture))
            timestamp = output["generatedAt"].replace(":", "").replace("-", "").replace(".", "")
            bench_dir = root / ".agentrail" / "context" / "benchmarks"
            bench_dir.mkdir(parents=True, exist_ok=True)
            json_path = bench_dir / f"{timestamp}-retrieval-benchmark.json"
            json_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
            summary = format_benchmark_summary(output)
            results_dir = root / "docs" / "benchmarks" / "results"
            results_dir.mkdir(parents=True, exist_ok=True)
            (results_dir / "context-retrieval-variants-latest.md").write_text(summary, encoding="utf-8")
            if json_output:
                _print_json(output)
            else:
                print(summary)
                print(f"json: {json_path.relative_to(root)}")
                print("summary: docs/benchmarks/results/context-retrieval-variants-latest.md")
            return 0 if output.get("passed") else 1
        if kind == "build":
            if len(rest) < 2:
                raise SystemExit("context build requires target kind: issue or pr")
            target_kind = rest[0]
            if target_kind not in {"issue", "pr"}:
                raise SystemExit("context build requires target kind: issue or pr")
            if not rest[1].isdigit():
                raise SystemExit("context build requires a numeric target")
            target_number = int(rest[1])
            target: str | None = None
            phase = ""
            json_output = False
            index = 2
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--phase":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--phase requires a value")
                    phase = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context build option: {arg}")
            if not phase:
                raise SystemExit("context build requires --phase")
            if target_kind == "issue" and phase not in {"plan", "execute", "verify"} or target_kind == "pr" and phase != "review":
                raise SystemExit("context build phase must be one of: issue plan|execute|verify, pr review")
            output = build_context_pack(_resolve_target(target), target_kind, target_number, phase)
            if json_output:
                _print_json(output)
            else:
                print(f"jsonPath={output['jsonPath']}")
                print(f"markdownPath={output['markdownPath']}")
            return 0
        if kind in {"show", "explain"}:
            if not rest or rest[0].startswith("--"):
                raise SystemExit(f"context {kind} requires a pack id or file")
            pack = rest[0]
            target: str | None = None
            json_output = False
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context {kind} option: {arg}")
            if kind == "show":
                output = show_context_pack(_resolve_target(target), pack, json_output=json_output)
                if json_output:
                    _print_json(output)
                else:
                    print(output)
            else:
                output = explain_context_pack(_resolve_target(target), pack)
                if json_output:
                    _print_json(output)
                else:
                    print(f"packId={output['packId']}")
                    print(f"includedCount={output['includedCount']}")
                    print(f"excludedCount={output['excludedCount']}")
                    print(f"providerMode={output['provider'].get('mode') if output.get('provider') else None}")
                    for section, items in output["sections"].items():
                        print(f"{section}: {len(items)}")
                        for item in items:
                            print(f"- {item['path']}: {item['reason']} citation={item['citation']}")
            return 0
        if kind == "savings":
            target, remaining = _parse_target(rest)
            json_output = "--json" in remaining
            remaining = [a for a in remaining if a != "--json"]
            if remaining:
                raise SystemExit(f"Unknown context savings option: {remaining[0]}")
            packs_dir = target / ".agentrail" / "context" / "packs"
            sessions: List[dict] = []
            total = 0
            for pack_file in sorted(packs_dir.glob("*.json")):
                try:
                    pack = json.loads(pack_file.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if not isinstance(pack, dict):
                    continue
                included = pack.get("included")
                if not isinstance(included, list):
                    included = []
                saved = compute_tokens_saved(target, included)
                total += saved
                sessions.append({
                    "packId": pack.get("packId") if isinstance(pack.get("packId"), str) else pack_file.stem,
                    "generatedAt": pack.get("generatedAt") if isinstance(pack.get("generatedAt"), str) else "",
                    "tokensSaved": saved,
                })
            sessions.sort(key=lambda s: s["generatedAt"], reverse=True)
            output = {"tokensSaved": total, "sessions": sessions}
            if json_output:
                _print_json(output)
            else:
                print(f"tokensSaved: {total}")
                for session in sessions:
                    print(f"{session['generatedAt']} {session['packId']} tokensSaved={session['tokensSaved']}")
            return 0
        if kind in {"", "-h", "--help"}:
            print(_usage())
            return 0
        print(f"Unknown context command: {kind}", file=sys.stderr)
        print(_usage(), file=sys.stderr)
        return 2
    except SystemExit as error:
        message = str(error)
        if message and message != "0":
            print(message, file=sys.stderr)
            return int(error.code) if isinstance(error.code, int) and error.code else 2
        raise
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
