from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import List, Tuple

from agentrail.context.embeddings import embed_context
from agentrail.context.evaluation import evaluate_retrieval, format_evaluation_report
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, explain_context_pack, show_context_pack
from agentrail.context.retrieval import query_context
from agentrail.context.sources import inventory_sources


def _resolve_target(value: str | None) -> Path:
    return Path(value or ".").resolve()


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
  agentrail context query "<task>" [--target DIR] [--json] [--limit N]
  agentrail context evaluate FIXTURE [--target DIR] [--json]
  agentrail context build issue NUMBER --phase PHASE [--target DIR] [--json]
  agentrail context build pr NUMBER --phase review [--target DIR] [--json]
  agentrail context show PACK [--target DIR] [--json]
  agentrail context explain PACK [--target DIR] [--json]
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
            if remaining:
                raise SystemExit(f"Unknown option: {remaining[0]}")
            _print_json(build_index(target))
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
            output = query_context(_resolve_target(target), query, limit=max(1, min(100, limit)))
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
