"""``agentrail heartbeat run`` — the live dispatcher daemon (MVP loop).

This is the only place the **real** adapters are constructed and handed to the
otherwise-hermetic :class:`~agentrail.heartbeat.runtime.HeartbeatRuntime`:

- the Issue Queue store on the production ``PostgresExecutor`` (DATABASE_URL);
- the GitHub poll client, polling the workspace's linked repos with a
  freshly minted GitHub App installation token (resolved via the Python
  token provider, ``agentrail.heartbeat.token_provider.get_github_token`` —
  no stored OAuth ``access_token`` is read);
- (optional, issue #1036) a symmetric Linear poll client, added when the
  workspace has an enabled Linear connector AND ``AGENTRAIL_MCP_LINEAR_KEY`` is
  set — trigger-labeled Linear issues then flow through the SAME shared
  Input-Contract gate and land in the queue with ``source = "linear"``;
- the Docker sandbox runner (``run_issue_in_sandbox``);
- a thin Discord notifier built from the workspace's configured webhook.

``run`` loops one ``poll_and_dispatch`` cycle every ``--interval`` seconds;
``--once`` runs a single cycle (demo/test). The prerequisite gate is respected
inside the runtime — a disabled gate refuses to dispatch and the loop exits clean.

Adapter construction is injectable via ``runtime_factory`` so the CLI's control
flow (subcommand/flag parsing, the once-vs-loop branch) is unit-tested with a
fake runtime, never touching Postgres / Docker / GitHub.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Callable, List, Optional

DEFAULT_INTERVAL = 60  # seconds between cycles in loop mode


class _UsageError(Exception):
    def __init__(self, message: str, code: int = 2):
        super().__init__(message)
        self.code = code


def _usage() -> str:
    return (
        "Usage:\n"
        "  agentrail heartbeat run [--workspace ID] [--once] [--interval SECONDS]\n"
        "  agentrail heartbeat serve [--workspace ID] [--port PORT]\n"
        "\n"
        "`run` polls GitHub on a cadence; `serve` reacts to delivered `issues`\n"
        "webhooks (local forwarding via `gh webhook forward`) — see "
        "`serve --help`.\n"
        "\n"
        "Runs the live Heartbeat dispatcher loop: poll GitHub → enqueue →\n"
        "dispatch grabbable issues in a Docker sandbox → post back + notify →\n"
        "idle on empty. Respects the prerequisite gate (won't dispatch if OFF).\n"
        "\n"
        "By default repos / trigger label / poll interval are read from the\n"
        "workspace's active GitHub CONNECTOR (configured on the Connectors page);\n"
        "the flags below override that stored config.\n"
        "\n"
        "Options:\n"
        "  --workspace ID        Workspace to run for (or AGENTRAIL_WORKSPACE_ID)\n"
        "  --once                Run a single cycle and exit (demo/test)\n"
        "  --interval SECONDS    Override seconds between cycles in loop mode "
        f"(connector config, else {DEFAULT_INTERVAL})\n"
        "  --repos a/b,c/d       Override comma-separated repos to poll (or "
        "AGENTRAIL_HEARTBEAT_REPOS)\n"
        "  --trigger-label NAME  Override the issue label that admits work "
        "(connector config, else ready-for-agent)\n"
        "\n"
        "Environment:\n"
        "  DATABASE_URL              Postgres DSN for the Issue Queue store\n"
        "  AGENTRAIL_WORKSPACE_ID    Default workspace id\n"
        "  AGENT_API_KEY / GIT_TOKEN Forwarded into the sandbox by name\n"
        "  DISCORD_WEBHOOK_URL       Channel webhook for notifications (optional)\n"
        "  AGENTRAIL_MCP_LINEAR_KEY  Linear API key; with an enabled Linear "
        "connector, admits trigger-labeled Linear issues (source=linear) (optional)\n"
        "  AGENTRAIL_CHEAP_MODEL     Model for the first (cheap) attempt (optional)\n"
        "  AGENTRAIL_STRONG_MODEL    Model the loop escalates to on a red gate\n"
        "  AGENTRAIL_PER_ISSUE_CEILING_USD  Per-issue $ cost ceiling, halts the run "
        "when exceeded (default 0 = uncapped; opt in above your costliest legit run)\n"
        "  AGENTRAIL_ATTEMPT_LIMIT   Max attempts before stop-to-human (default 2)\n"
        "  AGENTRAIL_QUEUE_GUARDRAILS_V2  Set to 1 to enable the Input-Contract v2 "
        "queue-entrance guardrails (injection screen / duplicate-content dedup / "
        "per-writer rate limit). Default OFF; a positive check PARKS the entry for "
        "human review, it never drops a legitimate issue (#1022)\n"
        "\n"
        "Linear intake dry-run (manual, real workspace):\n"
        "  1. Enable a Linear connector for the workspace on the Connectors page\n"
        "     (set its trigger label, e.g. `ready-for-agent`).\n"
        "  2. Create a Linear API key and export it:\n"
        "       export AGENTRAIL_MCP_LINEAR_KEY=lin_api_...\n"
        "  3. Add the trigger label to one Linear issue that has a machine-checkable\n"
        "     acceptance criterion (a `- [ ]` checkbox under `## Acceptance criteria`).\n"
        "  4. Run a single cycle:\n"
        "       agentrail heartbeat run --workspace <ID> --once\n"
        "     The one-line report shows `enqueued>=1`; the queue row carries\n"
        "     source=linear, and the run's outcome is commented back on the Linear\n"
        "     issue. An issue whose body trips the injection screen is parked (with\n"
        "     the v2 gate ON) or rejected — identically to the GitHub path.\n"
    )


def _parse(args: List[str]) -> dict:
    """Parse the ``run`` subcommand flags. Raises :class:`_UsageError`."""
    if not args or args[0] != "run":
        raise _UsageError("heartbeat: expected subcommand 'run'")
    # repos / trigger_label / interval default to None so the connector seam
    # (list_active_connectors) can fill them in. An explicit CLI flag or env var
    # is an OVERRIDE — it wins over the connector's stored config. This is how
    # the daemon "configures itself from the connector" while staying testable.
    env_repos = os.environ.get("AGENTRAIL_HEARTBEAT_REPOS")
    env_label = os.environ.get("AGENTRAIL_TRIGGER_LABEL")
    env_interval = os.environ.get("AGENTRAIL_HEARTBEAT_INTERVAL")
    opts = {
        "workspace": os.environ.get("AGENTRAIL_WORKSPACE_ID"),
        "once": False,
        "interval": _int(env_interval, "AGENTRAIL_HEARTBEAT_INTERVAL")
        if env_interval
        else None,
        "repos": env_repos,
        "trigger_label": env_label,
    }
    rest = args[1:]
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--once":
            opts["once"] = True
        elif a == "--workspace":
            i += 1
            opts["workspace"] = _value(rest, i, "--workspace")
        elif a == "--interval":
            i += 1
            opts["interval"] = _int(_value(rest, i, "--interval"), "--interval")
        elif a == "--repos":
            i += 1
            opts["repos"] = _value(rest, i, "--repos")
        elif a == "--trigger-label":
            i += 1
            opts["trigger_label"] = _value(rest, i, "--trigger-label")
        else:
            raise _UsageError(f"heartbeat: unknown option {a!r}")
        i += 1
    if not opts["workspace"]:
        raise _UsageError(
            "heartbeat: --workspace is required (or set AGENTRAIL_WORKSPACE_ID)"
        )
    return opts


def _value(rest: List[str], i: int, flag: str) -> str:
    if i >= len(rest):
        raise _UsageError(f"heartbeat: {flag} needs a value")
    return rest[i]


def _int(raw: str, flag: str) -> int:
    try:
        return int(raw)
    except ValueError as exc:
        raise _UsageError(f"heartbeat: {flag} must be an integer") from exc


# --------------------------------------------------------------------------- #
# Real-adapter factory (the only impure construction site)
# --------------------------------------------------------------------------- #
def _build_runtime(
    *,
    workspace_id: str,
    repos=None,
    trigger_label: Optional[str] = None,
    interval: Optional[int] = None,
):  # pragma: no cover - needs live creds/DB
    """Construct the real HeartbeatRuntime, configured FROM THE CONNECTOR.

    The daemon no longer reads its trigger config from a standalone heartbeat
    config / required CLI args: it sources repos / trigger_label / poll interval
    from the workspace's active GitHub **connector** (``list_active_connectors``)
    — adding the connector self-configures the loop. An explicit ``repos`` /
    ``trigger_label`` / ``interval`` (CLI flag or env) is still honored as an
    OVERRIDE so this stays scriptable / testable.

    Returns ``(runtime, effective_interval_seconds)`` — the caller's loop sleeps
    on the connector-derived interval. Not unit-tested (it wires
    Postgres/Docker/GitHub); the CLI control flow is tested through an injected
    ``runtime_factory`` instead.
    """
    from agentrail.afk.connectors_store import get_active_connector
    from agentrail.afk.queue_store import PostgresExecutor, QueueStore
    from agentrail.connectors.github import GitHubOAuthClient
    from agentrail.connectors.linear import LinearPollClient
    from agentrail.heartbeat.runtime import (
        DEFAULT_PER_ISSUE_CEILING_USD,
        HeartbeatRuntime,
        RuntimeConfig,
    )
    from agentrail.heartbeat.token_provider import get_github_token
    from agentrail.sandbox.native_runner import select_sandbox_runner

    executor = PostgresExecutor()
    store = QueueStore(executor)

    token = get_github_token(workspace_id, executor)
    if not token:
        raise _UsageError(
            f"heartbeat: no GitHub App installation for workspace "
            f"{workspace_id!r}; install the Jace GitHub App in the dashboard "
            "first",
            code=1,
        )

    # Self-configure from the active GitHub connector; CLI/env overrides win.
    gh = get_active_connector(workspace_id, "github", executor)
    if gh is None and not repos:
        raise _UsageError(
            f"heartbeat: no enabled GitHub connector for workspace "
            f"{workspace_id!r}; connect GitHub on the Connectors page first",
            code=1,
        )
    repo_list = list(repos) if repos else (gh.repos if gh else [])
    effective_label = trigger_label or (
        gh.trigger_label if gh else "ready-for-agent"
    )
    effective_interval = interval or (
        gh.poll_interval_seconds if gh else DEFAULT_INTERVAL
    )

    connector = GitHubOAuthClient(
        token=token, repos=repo_list, trigger_label=effective_label
    )

    # Linear intake (issue #1036): if the workspace has an ENABLED Linear connector
    # AND a Linear API key is configured, add a symmetric Linear poll client so
    # trigger-labeled Linear issues flow through the SAME shared Input-Contract gate
    # and land in the queue with ``source = "linear"``. Absent either the connector
    # or the key, the loop is GitHub-only exactly as before (no behaviour change).
    # The key reuses the established Linear-secret env var (AGENTRAIL_MCP_LINEAR_KEY,
    # the same one the MCP config reads) so a workspace configures it in one place.
    connectors = [connector]
    linear_cfg = get_active_connector(workspace_id, "linear", executor)
    linear_key = os.environ.get("AGENTRAIL_MCP_LINEAR_KEY") or os.environ.get(
        "LINEAR_API_KEY"
    )
    if linear_cfg is not None and linear_key:
        linear_label = trigger_label or linear_cfg.trigger_label
        connectors.append(
            LinearPollClient(api_key=linear_key, trigger_label=linear_label)
        )

    # Secrets forwarded into the sandbox by name (never on the command line).
    env = {}
    for key in ("AGENT_API_KEY", "GIT_TOKEN", "ANTHROPIC_API_KEY"):
        if os.environ.get(key):
            env[key] = os.environ[key]

    # Repo url/ref for the sandbox: first linked repo (MVP single-repo dispatch).
    repo_url = os.environ.get("AGENTRAIL_HEARTBEAT_REPO_URL") or (
        f"https://github.com/{repo_list[0]}.git" if repo_list else ""
    )
    ref = os.environ.get("AGENTRAIL_HEARTBEAT_REF", "main")

    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    notifier = _DiscordNotifier(webhook_url)

    # Cheap→strong escalation knobs (M036). The two model names map to the CHEAP
    # and STRONG tiers; the per-issue ceiling + attempt limit bound the loop. These
    # come from env today (a dashboard-managed config table is the later source);
    # an unset model lets the runner image pick its default.
    cheap_model = os.environ.get("AGENTRAIL_CHEAP_MODEL") or None
    strong_model = os.environ.get("AGENTRAIL_STRONG_MODEL") or None
    # Per-issue $ ceiling defaults to uncapped (DEFAULT_PER_ISSUE_CEILING_USD =
    # 0.0): the leash is opt-in, since a flat ceiling can't separate a runaway
    # from a costly-but-legit task. Set AGENTRAIL_PER_ISSUE_CEILING_USD above your
    # most expensive legitimate run to arm it as a catastrophe backstop.
    ceiling = _float_env(
        "AGENTRAIL_PER_ISSUE_CEILING_USD", DEFAULT_PER_ISSUE_CEILING_USD
    )
    attempt_limit = max(1, int(_float_env("AGENTRAIL_ATTEMPT_LIMIT", 2)))

    config = RuntimeConfig(
        workspace_id=workspace_id, repo_url=repo_url, ref=ref, env=env,
        cheap_model=cheap_model, strong_model=strong_model,
        ceiling=ceiling, attempt_limit=attempt_limit,
    )
    # Pick the execution backend: host-native by default (local dev — the agent
    # CLI uses the host login + its own native sandbox), Docker when an
    # ANTHROPIC_API_KEY is present (CI / cloud, where API-key auth works in a
    # container). See agentrail/sandbox/native_runner.select_sandbox_runner.
    sandbox_runner = select_sandbox_runner(dict(os.environ))
    runtime = HeartbeatRuntime(
        connectors=connectors,
        store=store,
        sandbox_runner=sandbox_runner,
        notifier=notifier,
        config=config,
    )
    # The loop sleeps on the connector-derived (or overridden) interval.
    return runtime, effective_interval


class _DiscordNotifier:  # pragma: no cover - thin pass-through over discord seams
    """Adapts the workspace webhook to the runtime's Notifier protocol."""

    def __init__(self, webhook_url: Optional[str]):
        self._webhook_url = webhook_url

    def task_done(self, result) -> None:
        from agentrail.connectors import discord

        discord.notify_task_done(webhook_url=self._webhook_url, result=result)

    def daily_digest(self, finished) -> None:
        from agentrail.connectors import discord

        discord.notify_daily_digest(webhook_url=self._webhook_url, finished=finished)


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def run_heartbeat(
    args: List[str],
    *,
    runtime_factory: Optional[Callable[..., object]] = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """``agentrail heartbeat run`` entry point.

    ``runtime_factory`` and ``sleep`` are injectable so the once/loop control
    flow is unit-tested with a fake runtime and no real sleeping.
    """
    if args and args[0] in ("-h", "--help"):
        print(_usage(), end="")
        return 0

    # The webhook receiver is a sibling subcommand of ``run``: it reacts to
    # delivered GitHub events (local forwarding) instead of polling on a cadence.
    if args and args[0] == "serve":
        return serve_heartbeat(args)

    try:
        opts = _parse(args)
    except _UsageError as exc:
        print(str(exc), file=sys.stderr)
        print(_usage(), end="", file=sys.stderr)
        return exc.code

    factory = runtime_factory or _build_runtime
    # repos override is parsed from the flag/env; None means "use the connector".
    repos = _split_repos(opts["repos"]) if opts["repos"] else None
    try:
        built = factory(
            workspace_id=opts["workspace"],
            repos=repos,
            trigger_label=opts["trigger_label"],
            interval=opts["interval"],
        )
    except _UsageError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code

    # The factory may return ``runtime`` or ``(runtime, effective_interval)``.
    # The real factory derives the interval from the connector; an injected fake
    # may return just the runtime, in which case fall back to the CLI/default.
    if isinstance(built, tuple):
        runtime, effective_interval = built
    else:
        runtime = built
        effective_interval = opts["interval"] or DEFAULT_INTERVAL

    if opts["once"]:
        _run_cycle(runtime, opts["workspace"])
        return 0

    # Loop forever: one cycle per interval. Ctrl-C exits clean.
    try:
        while True:
            _run_cycle(runtime, opts["workspace"])
            sleep(effective_interval)
    except KeyboardInterrupt:  # pragma: no cover - interactive
        print("heartbeat: stopped", file=sys.stderr)
        return 0


def _run_cycle(runtime, workspace_id: str) -> None:
    """Run one cycle and print a one-line report."""
    report = runtime.poll_and_dispatch(workspace_id)
    if not getattr(report, "enabled", True):
        print("heartbeat: prerequisite gate OFF — dispatch disabled, idling")
        return
    print(
        "heartbeat: "
        f"polled={report.polled} enqueued={report.enqueued} "
        f"dispatched={report.dispatched} green={report.green} red={report.red}"
    )


def _split_repos(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    return [r.strip() for r in raw.split(",") if r.strip()]


def _float_env(name: str, default: float) -> float:
    """Read a numeric env var, falling back to ``default`` on absent/bad values."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


# --------------------------------------------------------------------------- #
# ``agentrail heartbeat serve`` — the webhook receiver (local forwarding)
# --------------------------------------------------------------------------- #
DEFAULT_PORT = 8787


def _serve_usage() -> str:
    return (
        "Usage:\n"
        "  agentrail heartbeat serve [--workspace ID] [--port PORT]\n"
        "\n"
        "Starts a local HTTP receiver for GitHub `issues` webhooks. When an issue\n"
        "is labeled with the workspace connector's trigger label, the issue is\n"
        "enqueued (deduped) and dispatched through the cheap→strong escalation\n"
        "loop — no polling; the delivered event IS the issue. Respects the\n"
        "prerequisite gate (won't dispatch if OFF).\n"
        "\n"
        "Forward GitHub deliveries to it locally (no public ingress) with:\n"
        "  gh webhook forward --repo <owner/name> --events issues \\\n"
        "      --url http://localhost:<port>/webhook\n"
        "(set --secret on `gh webhook forward` AND GITHUB_WEBHOOK_SECRET here to\n"
        "require a verified HMAC-SHA256 signature; without a secret the receiver\n"
        "accepts unsigned deliveries, which is insecure.)\n"
        "\n"
        "Options:\n"
        "  --workspace ID   Workspace to serve for (or AGENTRAIL_WORKSPACE_ID)\n"
        f"  --port PORT      Port to listen on (default {DEFAULT_PORT})\n"
        "\n"
        "Environment:\n"
        "  DATABASE_URL            Postgres DSN for the Issue Queue store\n"
        "  AGENTRAIL_WORKSPACE_ID  Default workspace id\n"
        "  GITHUB_WEBHOOK_SECRET   Shared secret for X-Hub-Signature-256 (optional)\n"
        "  AGENT_API_KEY / GIT_TOKEN  Forwarded into the sandbox by name\n"
    )


def _parse_serve(args: List[str]) -> dict:
    """Parse the ``serve`` subcommand flags. Raises :class:`_UsageError`."""
    opts = {
        "workspace": os.environ.get("AGENTRAIL_WORKSPACE_ID"),
        "port": DEFAULT_PORT,
    }
    rest = args[1:]
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--workspace":
            i += 1
            opts["workspace"] = _value(rest, i, "--workspace")
        elif a == "--port":
            i += 1
            opts["port"] = _int(_value(rest, i, "--port"), "--port")
        else:
            raise _UsageError(f"heartbeat: unknown option {a!r}")
        i += 1
    if not opts["workspace"]:
        raise _UsageError(
            "heartbeat: --workspace is required (or set AGENTRAIL_WORKSPACE_ID)"
        )
    return opts


def serve_heartbeat(
    args: List[str],
    *,
    server_factory: Optional[Callable[..., object]] = None,
) -> int:
    """``agentrail heartbeat serve`` entry point.

    Starts the webhook receiver, wiring the real adapters (PostgresExecutor store,
    the active GitHub connector for the trigger label, the escalation runtime, a
    freshly minted GitHub App installation token). ``server_factory`` is
    injectable so the CLI control flow (flag parsing, the printed
    ``gh webhook forward`` hint, ``serve_forever`` dispatch) is unit-tested with
    a fake server — never touching Postgres / a real socket.
    """
    if args and args[1:] and args[1] in ("-h", "--help"):
        print(_serve_usage(), end="")
        return 0
    try:
        opts = _parse_serve(args)
    except _UsageError as exc:
        print(str(exc), file=sys.stderr)
        print(_serve_usage(), end="", file=sys.stderr)
        return exc.code

    factory = server_factory or _build_server
    try:
        built = factory(workspace_id=opts["workspace"], port=opts["port"])
    except _UsageError as exc:
        print(str(exc), file=sys.stderr)
        return exc.code

    # The factory may return ``server`` or ``(server, trigger_label, repos)`` so
    # the CLI can print an accurate ``gh webhook forward`` hint.
    trigger_label, repos = None, []
    if isinstance(built, tuple):
        server = built[0]
        if len(built) > 1:
            trigger_label = built[1]
        if len(built) > 2:
            repos = built[2] or []
    else:
        server = built

    port = getattr(server, "port", opts["port"])
    print(f"heartbeat: webhook receiver listening on http://localhost:{port}/webhook")
    if trigger_label:
        print(f"heartbeat: trigger label = {trigger_label!r}")
    print("heartbeat: forward GitHub deliveries with:")
    for repo in (repos or ["<owner/name>"]):
        print(
            f"  gh webhook forward --repo {repo} --events issues "
            f"--url http://localhost:{port}/webhook"
        )
    if not os.environ.get("GITHUB_WEBHOOK_SECRET"):
        print(
            "heartbeat: WARNING — GITHUB_WEBHOOK_SECRET unset; accepting unsigned "
            "deliveries (insecure). Set it and `gh webhook forward --secret` to verify."
        )

    server.serve_forever()
    return 0


def _build_server(
    *, workspace_id: str, port: int
):  # pragma: no cover - needs live creds/DB
    """Construct the real WebhookServer — the only impure construction site.

    Mirrors ``_build_runtime``: same PostgresExecutor-backed store, same
    connector-sourced trigger config, same escalation runtime — only the trigger
    is a delivered event instead of a poll. Returns
    ``(server, trigger_label, repos)`` so the caller prints an accurate hint.
    """
    from agentrail.afk.connectors_store import get_active_connector
    from agentrail.afk.queue_store import PostgresExecutor, QueueStore
    from agentrail.heartbeat.webhook import WebhookServer

    runtime, _interval = _build_runtime(workspace_id=workspace_id)
    executor = PostgresExecutor()
    store = QueueStore(executor)

    gh = get_active_connector(workspace_id, "github", executor)
    if gh is None:
        raise _UsageError(
            f"heartbeat: no enabled GitHub connector for workspace "
            f"{workspace_id!r}; connect GitHub on the Connectors page first",
            code=1,
        )

    server = WebhookServer(
        workspace_id=workspace_id,
        store=store,
        runtime=runtime,
        connector_config=gh,
        port=port,
        secret=os.environ.get("GITHUB_WEBHOOK_SECRET"),
    )
    return server, gh.trigger_label, gh.repos
