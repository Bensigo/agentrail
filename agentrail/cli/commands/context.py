from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

from agentrail.context.pricing import cost_for as _cost_for
from agentrail.context.embeddings import embed_context, setup_embeddings
from agentrail.context.ast_search import ast_query
from agentrail.context.benchmark import format_benchmark_summary, run_benchmark
from agentrail.context.evaluation import evaluate_retrieval, format_evaluation_report
from agentrail.context.git_commands import git_blame, git_changed, git_history
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, explain_context_pack, show_context_pack
from agentrail.context.retrieval import compute_tokens_saved, context_callers, context_callees, context_def, context_impact, get_file_lines, get_file_symbol, query_context, search_context
from agentrail.context.sources import inventory_sources
from agentrail.context import daemon as _daemon_mod
from agentrail.context.client import _resolve_context_client


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
  agentrail context ast "<s-expression>" [--target DIR] [--json] [--limit N]
  agentrail context def NAME [--target DIR] [--json]
  agentrail context callers NAME [--target DIR] [--json]
  agentrail context callees NAME [--target DIR] [--json]
  agentrail context impact NAME [--depth N] [--target DIR] [--json]
  agentrail context query "<task>" [--target DIR] [--json] [--limit N]
  agentrail context search "<query>" [--target DIR] [--json] [--limit N]
  agentrail context get PATH (--lines A-B | --symbol NAME) [--target DIR] [--json]
  agentrail context blame PATH --lines A-B [--target DIR] [--json]
  agentrail context history PATH [--symbol NAME] [--target DIR] [--json]
  agentrail context changed [--since REF] [--target DIR] [--json]
  agentrail context evaluate FIXTURE [--target DIR] [--json]
  agentrail context benchmark FIXTURE [--target DIR] [--json] [--compare-grep]
  agentrail context build issue NUMBER --phase PHASE [--budget-usd N] [--model M] [--target DIR] [--json]
  agentrail context build pr NUMBER --phase review [--budget-usd N] [--model M] [--target DIR] [--json]
  agentrail context show PACK [--target DIR] [--json]
  agentrail context explain PACK [--target DIR] [--json]
  agentrail context savings [--model M] [--target DIR] [--json]
  agentrail context daemon start [--target DIR]
  agentrail context daemon stop [--target DIR]
  agentrail context daemon status [--target DIR] [--json]
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


def _run_daemon(args: List[str]) -> int:
    """Dispatch ``agentrail context daemon start|stop|status``."""
    action = args[0] if args else ""
    rest = args[1:] if args else []

    if action not in {"start", "stop", "status"}:
        raise SystemExit(
            f"Unknown daemon action: {action!r}. Use start, stop, or status."
            if action
            else "context daemon requires an action: start, stop, or status"
        )

    # Parse shared options: --target and (for status) --json
    target_str: str | None = None
    json_output = False
    index = 0
    while index < len(rest):
        arg = rest[index]
        if arg == "--target":
            if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                raise SystemExit("--target requires a directory")
            target_str = rest[index + 1]
            index += 2
        elif arg == "--json":
            if action != "status":
                raise SystemExit(f"--json is only valid for daemon status")
            json_output = True
            index += 1
        else:
            raise SystemExit(f"Unknown daemon {action} option: {arg}")

    target = _resolve_target(target_str)
    socket_path = _daemon_mod.socket_path_for(target)

    if action == "start":
        # Idempotency: if socket exists and daemon responds, report it running.
        if socket_path.exists() and _daemon_mod.ping(socket_path):
            try:
                status_resp = _daemon_mod.rpc(socket_path, "status")
                pid = status_resp.get("result", status_resp).get("pid", "?")
            except Exception:
                pid = "?"
            print(f"Daemon already running (pid={pid})")
            return 0
        # Remove stale socket before spawning.
        if socket_path.exists():
            try:
                socket_path.unlink()
            except OSError:
                pass
        pid = _daemon_mod.start_detached(target)
        if not _daemon_mod._wait_for_socket(socket_path, timeout=10.0):
            print(
                f"warning: daemon process spawned (pid={pid}) but socket did not appear "
                f"at {socket_path} within 10 s",
                file=sys.stderr,
            )
            return 1
        print(f"Daemon started (pid={pid})")
        return 0

    if action == "stop":
        if not socket_path.exists() or not _daemon_mod.ping(socket_path):
            print(f"Daemon not running for target {target}", file=sys.stderr)
            return 1
        try:
            _daemon_mod.rpc(socket_path, "shutdown", timeout=5.0)
        except Exception:
            pass  # daemon may close before replying
        if _daemon_mod._wait_for_socket_gone(socket_path, timeout=5.0):
            print("Daemon stopped")
            return 0
        print("warning: daemon did not stop within 5 s; socket still present", file=sys.stderr)
        return 1

    # action == "status"
    if not socket_path.exists() or not _daemon_mod.ping(socket_path):
        print(f"Daemon not running for target {target}", file=sys.stderr)
        return 1
    try:
        resp = _daemon_mod.rpc(socket_path, "status", timeout=5.0)
    except Exception as exc:
        print(f"Daemon not running for target {target}", file=sys.stderr)
        return 1
    status = resp.get("result", resp)
    if json_output:
        _print_json(status)
    else:
        pid = status.get("pid", "?")
        uptime = status.get("uptimeSeconds", "?")
        last_indexed = status.get("lastIndexedAt", "?")
        state = status.get("state", "?")
        print(f"PID:          {pid}")
        print(f"uptime:       {uptime}s")
        print(f"last indexed: {last_indexed}")
        print(f"socket:       {status.get('socketPath', socket_path)}")
        print(f"state:        {state}")
    return 0


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
        if kind == "ast":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context ast requires an s-expression")
            s_expr = rest[0]
            target: str | None = None
            json_output = False
            limit = 50
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
                    raise SystemExit(f"Unknown context ast option: {arg}")
            resolved_target = _resolve_target(target)
            _touch_context_marker(resolved_target)
            output = ast_query(resolved_target, s_expr, limit=max(1, min(100, limit)))
            if json_output:
                _print_json(output)
            else:
                for item in output["results"]:
                    print(f"{item['citation']} {item['reason']}")
            return 0
        if kind == "def":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context def requires a symbol name")
            name = rest[0]
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
                    raise SystemExit(f"Unknown context def option: {arg}")
            resolved_target = _resolve_target(target)
            results = _resolve_context_client(resolved_target).def_(name)
            if json_output:
                _print_json(results)
            else:
                for item in results:
                    print(f"{item['path']}:{item['lineStart']} — {item['kind']} {name}")
            return 0
        if kind in {"callers", "callees"}:
            if not rest or rest[0].startswith("--"):
                raise SystemExit(f"context {kind} requires a symbol name")
            name = rest[0]
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
            resolved_target = _resolve_target(target)
            client = _resolve_context_client(resolved_target)
            if kind == "callers":
                results = client.callers(name)
                if json_output:
                    _print_json(results)
                else:
                    for item in results:
                        print(f"{item['callerPath']}:{item['callerLine']} calls {name}")
            else:
                results = client.callees(name)
                if json_output:
                    _print_json(results)
                else:
                    for item in results:
                        if item.get("resolved") is False:
                            print(f"unresolved:{item.get('unresolvedReason', '')} {item['citation']}")
                        else:
                            print(f"{item['path']}:{item['lineStart']} callee of {name}")
            return 0
        if kind == "impact":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context impact requires a symbol name")
            name = rest[0]
            target: str | None = None
            json_output = False
            impact_depth = 3
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
                elif arg == "--depth":
                    if index + 1 >= len(rest) or not rest[index + 1].isdigit():
                        raise SystemExit("--depth requires a numeric value")
                    impact_depth = int(rest[index + 1])
                    index += 2
                else:
                    raise SystemExit(f"Unknown context impact option: {arg}")
            resolved_target = _resolve_target(target)
            results = _resolve_context_client(resolved_target).impact(name, depth=impact_depth)
            if json_output:
                _print_json(results)
            else:
                for item in results:
                    print(f"{item['path']}:{item['lineStart']} — {item['reason']}")
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
            output = _resolve_context_client(resolved_target).query(query, limit=max(1, min(100, limit)))
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
            output = _resolve_context_client(resolved_target).search(query, limit=max(1, min(100, limit)))
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
        if kind == "blame":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context blame requires a path")
            path = rest[0]
            target: str | None = None
            json_output = False
            lines_spec: str | None = None
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
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context blame option: {arg}")
            if not lines_spec:
                raise SystemExit("context blame requires --lines A-B")
            match = re.fullmatch(r"(\d+)-(\d+)", lines_spec)
            if not match:
                raise SystemExit("--lines must be a numeric range like 12-48")
            output = git_blame(_resolve_target(target), path, int(match.group(1)), int(match.group(2)))
            if json_output:
                _print_json(output)
            else:
                for entry in output:
                    print(f"{entry['line']}\t{entry['sha'][:8]}\t{entry['author']}\t{entry['content']}")
            return 0
        if kind == "history":
            if not rest or rest[0].startswith("--"):
                raise SystemExit("context history requires a path")
            path = rest[0]
            target: str | None = None
            json_output = False
            symbol: str | None = None
            index = 1
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
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
                    raise SystemExit(f"Unknown context history option: {arg}")
            output = git_history(_resolve_target(target), path, symbol=symbol)
            if json_output:
                _print_json(output)
            else:
                for entry in output:
                    print(f"{entry['sha'][:8]}\t{entry['date']}\t{entry['author']}\t{entry['summary']}")
            return 0
        if kind == "changed":
            target: str | None = None
            json_output = False
            since = "HEAD"
            index = 0
            while index < len(rest):
                arg = rest[index]
                if arg == "--target":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--target requires a directory")
                    target = rest[index + 1]
                    index += 2
                elif arg == "--since":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--since requires a ref")
                    since = rest[index + 1]
                    index += 2
                elif arg == "--json":
                    json_output = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context changed option: {arg}")
            output = git_changed(_resolve_target(target), since=since)
            if json_output:
                _print_json(output)
            else:
                for entry in output:
                    print(f"{entry['status']}\t{entry['path']}")
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
            compare_grep = False
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
                elif arg == "--compare-grep":
                    compare_grep = True
                    index += 1
                else:
                    raise SystemExit(f"Unknown context benchmark option: {arg}")
            root = _resolve_target(target)
            output = run_benchmark(root, Path(fixture), compare_grep=compare_grep)
            timestamp = output["generatedAt"].replace(":", "").replace("-", "").replace(".", "")
            bench_dir = root / ".agentrail" / "context" / "benchmarks"
            bench_dir.mkdir(parents=True, exist_ok=True)
            json_path = bench_dir / f"{timestamp}-retrieval-benchmark.json"
            json_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
            summary = format_benchmark_summary(output, compare_grep=compare_grep)
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
            budget_usd: float | None = None
            build_model: str = "claude-sonnet-4-6"
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
                elif arg == "--budget-usd":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--budget-usd requires a value")
                    try:
                        parsed_budget = float(rest[index + 1])
                        if parsed_budget <= 0:
                            raise ValueError("non-positive")
                        budget_usd = parsed_budget
                    except ValueError:
                        print(f"Warning: --budget-usd value '{rest[index + 1]}' is invalid; skipping budget trim.", file=sys.stderr)
                    index += 2
                elif arg == "--model":
                    if index + 1 >= len(rest) or rest[index + 1].startswith("--"):
                        raise SystemExit("--model requires a model name")
                    build_model = rest[index + 1]
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
            # Read contextBudgetUsd from config if not provided via flag
            if budget_usd is None:
                try:
                    config_path = _resolve_target(target) / ".agentrail" / "config.json"
                    if config_path.exists():
                        cfg = json.loads(config_path.read_text(encoding="utf-8"))
                        cfg_budget = (cfg or {}).get("contextBudgetUsd")
                        if isinstance(cfg_budget, (int, float)) and cfg_budget > 0:
                            budget_usd = float(cfg_budget)
                except Exception:
                    pass
            output = build_context_pack(
                _resolve_target(target), target_kind, target_number, phase,
                budget_usd=budget_usd, model=build_model,
            )
            if json_output:
                _print_json(output)
            else:
                print(f"jsonPath={output['jsonPath']}")
                print(f"markdownPath={output['markdownPath']}")
                if "budgetUsd" in output:
                    print(f"budgetUsd=${output['budgetUsd']:.6f}")
                    print(f"packCostUsd=${output['packCostUsd']:.6f}  (model={output['costModel']})")
                    print(f"itemsDropped={output['itemsDropped']}")
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
            _DEFAULT_SAVINGS_MODEL = "claude-sonnet-4-6"
            target, remaining = _parse_target(rest)
            json_output = "--json" in remaining
            remaining = [a for a in remaining if a != "--json"]
            model = _DEFAULT_SAVINGS_MODEL
            i = 0
            filtered: List[str] = []
            while i < len(remaining):
                if remaining[i] == "--model":
                    if i + 1 >= len(remaining) or remaining[i + 1].startswith("--"):
                        raise SystemExit("--model requires a model name")
                    model = remaining[i + 1]
                    i += 2
                else:
                    filtered.append(remaining[i])
                    i += 1
            remaining = filtered
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
            cost = _cost_for(model, input_tokens=total)
            dollars_saved = cost["dollars"]
            rate = cost["rates"]["input"]
            is_estimate = cost["estimate"]
            output: dict = {"tokensSaved": total, "dollarsSaved": dollars_saved, "model": model, "rate": rate, "sessions": sessions}
            if is_estimate:
                output["estimate"] = True
            if json_output:
                _print_json(output)
            else:
                print(f"tokensSaved: {total}")
                print(f"dollarsSaved: ${dollars_saved:.4f}  (model={model}, rate=${rate:.2f}/MTok{', estimate=true' if is_estimate else ''})")
                for session in sessions:
                    print(f"{session['generatedAt']} {session['packId']} tokensSaved={session['tokensSaved']}")
            return 0
        if kind == "daemon":
            return _run_daemon(rest)
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
