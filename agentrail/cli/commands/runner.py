"""``agentrail runner`` — run the local worker that executes your queued issues.

This is the only thing the user runs after ``agentrail login``. It claims
dispatched issues from the backend, runs each one locally (host-native, on the
user's own agent subscription), and reports the outcome back. No DB URL, no API
key, no webhook forwarding — the backend owns all of that.

  agentrail runner [--idle SECONDS] [--once] [--concurrency N]

``--once`` drains a single claim and exits (handy for a cron tick); the default
runs forever. ``--concurrency N`` runs N issues at once (the backend's atomic
claim keeps two slots from grabbing the same issue).
"""
from __future__ import annotations

import inspect
import os
import sys
import time
from typing import List

from agentrail.runner.client import RunnerClient, WorkItem
from agentrail.runner.credentials import load_credentials
from agentrail.runner.escalation import model_for_tier
from agentrail.runner.worker import run_worker
from agentrail.sandbox.docker_runner import RunResult
from agentrail.sandbox.native_runner import select_sandbox_runner


def _make_execute(creds):
    """Build the execute callback: run a claimed issue on the host.

    The local run is linked back to the backend (``AGENTRAIL_SERVER_*``) so it
    ingests cost events + run telemetry, keyed to this run's id (= the dashboard
    run / queue entry id) so they join to the run the runner registered.
    """
    runner = select_sandbox_runner(dict(os.environ))
    _params = inspect.signature(runner).parameters
    accepts_run_id = "run_id" in _params
    accepts_pr_title = "pr_title" in _params
    accepts_model = "model" in _params
    accepts_budget = "budget_usd" in _params
    # #1391: the host runner accepts a mid-run GitHub-token refresher; the Docker
    # sandbox backend does not (its push happens in the container entrypoint), so
    # gate on the signature exactly like the other optional kwargs above.
    accepts_token_refresher = "github_token_refresher" in _params

    def execute(item: WorkItem) -> RunResult:
        if item.kind == "onboard":
            # This early return fires BEFORE the GIT_TOKEN wiring below ever
            # runs — but that wiring is for `run_env` (the issue-kind path's
            # subprocess env), which `run_onboard` doesn't use at all. `item`
            # itself already carries `github_token` (parsed unconditionally
            # by WorkItem.from_dict, same as any issue-kind item), and
            # run_onboard reads it directly and threads it into its own
            # clone step (agentrail/runner/onboard.py, #1268) — nothing is
            # dropped here.
            from agentrail.runner.onboard import run_onboard
            return run_onboard(item, base_url=creds.base_url, api_key=creds.token)
        # Build a NARROW run env — NOT a blanket ``dict(os.environ)`` (#1295 G1).
        # The host-native runner (``native_runner.build_native_child_env``)
        # pulls the justified allowlist (``ANTHROPIC_*`` model auth, the hosted
        # markers, the baked claude command, …) straight from THIS process's env
        # itself, so we only add the per-claim vars here. Copying os.environ
        # would smuggle ``FLEET_CONSOLE_TOKEN`` and every other operator secret
        # back into the untrusted agent's environment through ``env`` (which the
        # runner passes through untouched — the eval harness relies on that
        # passthrough for its own non-secret feature-flag vars, so the runner
        # cannot re-filter it). See the threat model's gap G1.
        run_env: dict = {}
        # Non-secret CONTROL flags the runner reads off ``env`` (which agent to
        # run; the optional whole-process sandbox wrapper). Forward them from
        # this process's env when an operator has set them so the override still
        # takes effect; they are not secrets and the runner needs them to build
        # the run command, not to authenticate anything.
        for _flag in ("AGENTRAIL_AGENT", "AGENTRAIL_SANDBOX_RUNTIME"):
            _flag_val = os.environ.get(_flag)
            if _flag_val is not None:
                run_env[_flag] = _flag_val
        # Link this run to the backend so cost/telemetry land on the dashboard.
        # Needs all three (base, key, repo) or load_link ignores it.
        run_env["AGENTRAIL_SERVER_BASE_URL"] = creds.base_url
        run_env["AGENTRAIL_SERVER_API_KEY"] = creds.token
        if item.repository_id:
            run_env["AGENTRAIL_SERVER_REPOSITORY_ID"] = item.repository_id
        # Export connected MCP keys so native_runner writes the agent's MCP config
        # (.mcp.json / .codex/config.toml) into the clone — the codebase-level
        # half of MCP connectors. Keys arrive decrypted from the claim payload.
        for provider, key in item.mcp_keys.items():
            run_env[f"AGENTRAIL_MCP_{provider.upper()}_KEY"] = key
        # GitHub auth: prefer the workspace's connected OAuth token the backend
        # resolved on the claim (per-workspace, no shared secret needed) over
        # whatever GIT_TOKEN is already in this process's own environment — set
        # it ONLY when the claim actually carries one, so a locally configured
        # GIT_TOKEN (PAT) still works as a fallback (older backends, or a
        # workspace with no linked GitHub owner). See
        # native_runner.run_issue_on_host for how GIT_TOKEN then authenticates
        # `git clone`/`git push`/`gh pr create`. NOTE: OAuth tokens issued at
        # login can expire; there is no refresh here (documented limitation) —
        # an expired token just surfaces as a normal git/gh auth failure.
        # NOTE: the onboard path above deliberately does NOT get this local
        # GIT_TOKEN fallback — claim-token only, to prevent cross-workspace
        # token bleed on the shared fleet process; see the clone call site in
        # agentrail/runner/onboard.py (run_onboard) for the full rationale.
        if item.github_token:
            run_env["GIT_TOKEN"] = item.github_token
        elif os.environ.get("GIT_TOKEN"):
            # Back-compat fallback: an older backend (or a workspace with no
            # linked GitHub owner) carries no claim token — a locally configured
            # GIT_TOKEN (PAT) in this process's own env still works. Forwarded
            # EXPLICITLY now that run_env is no longer a full os.environ copy
            # (#1295 G1); the claim token above still wins when present.
            run_env["GIT_TOKEN"] = os.environ["GIT_TOKEN"]
        # Bot commit identity (GitHub App swap spec §6): the claim carries
        # git_bot_name/git_bot_email when the console's App env is configured
        # (composed there via resolveGithubAppConfig+botCommitIdentity), so
        # pushed commits attribute to <slug>[bot] instead of the neutral
        # "AgentRail Runner" fallback. Threaded independently, each ONLY when
        # non-empty — native_runner._publish_green is the layer that requires
        # BOTH present before it will use them, falling back to its own
        # neutral identity otherwise. "" (an unconfigured App env, or an
        # older backend that predates this field) leaves the env key unset,
        # same shape as the GIT_TOKEN fallback above.
        if item.git_bot_name:
            run_env["AGENTRAIL_GIT_BOT_NAME"] = item.git_bot_name
        if item.git_bot_email:
            run_env["AGENTRAIL_GIT_BOT_EMAIL"] = item.git_bot_email
        kwargs = dict(
            repo_url=item.repo_url,
            ref=item.ref,
            issue_ref=item.issue_number,  # bare number; `run issue` rejects repo#N
            workspace_id=item.workspace_id,
            env=run_env,
        )
        # #1391 mid-run recovery: give the host runner a callback to refresh THIS
        # workspace's GitHub token over the runner-authed channel if a publish
        # push 401s because the OAuth token expired in-flight. Only wired when the
        # claim actually carried a workspace OAuth token (item.github_token) — a
        # locally configured PAT fallback (no github_token) is not an OAuth token
        # and cannot be refreshed this way. Constructs a per-workspace client
        # lazily so the refresh is authed exactly like claim/result.
        if accepts_token_refresher and item.github_token:
            def _refresh_github_token() -> "str | None":
                client = RunnerClient(
                    base_url=creds.base_url,
                    token=creds.token,
                    workspace_id=item.workspace_id,
                )
                return client.refresh_github_token(item.workspace_id)

            kwargs["github_token_refresher"] = _refresh_github_token
        if accepts_run_id:
            # Use the dashboard run id so ingested cost events join to it.
            kwargs["run_id"] = item.id
        if accepts_pr_title and item.title:
            kwargs["pr_title"] = item.title
        # Budget passthrough (#1275): the alignment brief's confirmed estimate,
        # when present, IS the run's enforced budget (owner rule: "confirming
        # the brief = sanctioning the ceiling") — pass it straight through as
        # --budget-usd + --budget-source "brief" so effective_budget /
        # effective_budget_source (agentrail/cli/commands/run.py) give it TOP
        # precedence over any --budget-usd flag/config/default this host would
        # otherwise apply. Dormant: item.estimated_budget_usd is None for
        # every claim until #1274's brief-generation lane starts writing a
        # value, so this is a no-op today — byte-identical argv. `is not None`
        # (not truthiness) so an explicit $0 estimate — a deliberate
        # "uncapped" choice, same convention as --budget-usd 0 — still forwards.
        if accepts_budget and item.estimated_budget_usd is not None:
            kwargs["budget_usd"] = item.estimated_budget_usd
            kwargs["budget_source"] = "brief"
        # Model: escalation vs. brief-confirmed override — CONTROLLER-DECIDED
        # precedence (#1275). Tier 0 ⇒ model_for_tier returns None ⇒ the
        # user's model_override (if any) wins, exactly like an explicit
        # --model flag would over the config default. Tier >= 1 ⇒ this
        # attempt is a re-queued RETRY of a PREVIOUS gate-red/error result
        # (nextQueueTransition, packages/db-postgres/src/queries/runner.ts) —
        # escalation ALWAYS wins over model_override here: the override
        # already ran once (at tier 0) and failed, so blindly re-running the
        # same user pick would burn the bounded retry budget (#890 — "retry on
        # error max 5 times") without ever reaching the stronger model the
        # escalation ladder exists to try. The override is not lost forever —
        # queue_entries.model_override is untouched by this decision, it is a
        # per-ATTEMPT precedence choice, not a deletion. No override and tier
        # 0 ⇒ neither branch fires ⇒ byte-identical to pre-#1275 behavior (no
        # model kwarg at all, local run uses the config default).
        # `decided_model` (#1338 PR① fix round) is the FINAL execute model
        # THIS attempt resolves to — the exact value that becomes `--model`
        # below. Captured here, at dispatch, so it can be reported back to the
        # backend AUTHORITATIVELY (stamped onto the RunResult after the run),
        # instead of the backend reconstructing it from lossy ClickHouse
        # cost_events (a dropped execute cost_event would otherwise null the
        # model on a genuine success — see run_outcomes.ts / result/route.ts).
        # "" when no model kwarg is passed (tier-0 no-override ⇒ the pipeline's
        # config default, unknowable at dispatch without duplicating pipeline
        # logic) — the backend keeps its ClickHouse fallback for exactly that
        # case, so this is a strict improvement, never a regression.
        decided_model = ""
        if accepts_model:
            escalated_model = model_for_tier(item.tier)
            if escalated_model:
                kwargs["model"] = escalated_model
                decided_model = escalated_model
            elif item.model_override:
                kwargs["model"] = item.model_override
                decided_model = item.model_override
        result = runner(**kwargs)
        # Stamp the resolved model onto the outcome the worker reports back.
        # Only when WE decided one AND the runner didn't already populate it
        # (a future runner that reads the actually-run model from run.json is
        # MORE authoritative than this dispatch-time decision — let it win).
        if decided_model and not getattr(result, "execute_model", ""):
            from dataclasses import replace

            try:
                result = replace(result, execute_model=decided_model)
            except TypeError:
                # A duck-typed/fake result without an execute_model field (older
                # test double) — reporting the model is best-effort, never fatal.
                pass
        return result

    return execute


def run_runner(args: List[str]) -> int:
    idle = 10.0
    once = False
    concurrency = 1
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(__doc__)
            return 0
        if a == "--idle":
            i += 1
            if i >= len(args):
                print("error: --idle requires a value", file=sys.stderr)
                return 1
            try:
                idle = float(args[i])
            except ValueError:
                print("error: --idle must be a number", file=sys.stderr)
                return 1
        elif a == "--concurrency":
            i += 1
            if i >= len(args):
                print("error: --concurrency requires a value", file=sys.stderr)
                return 1
            try:
                concurrency = max(1, int(args[i]))
            except ValueError:
                print("error: --concurrency must be an integer", file=sys.stderr)
                return 1
        elif a == "--once":
            once = True
        else:
            print(f"unknown option: {a}", file=sys.stderr)
            return 1
        i += 1

    creds = load_credentials()
    if creds is None:
        print("Not logged in. Run `agentrail login` first.", file=sys.stderr)
        return 1

    client = RunnerClient(
        base_url=creds.base_url,
        token=creds.token,
        workspace_id=creds.workspace_id,
    )

    # --once drains a single claim; concurrency only applies to the watch loop.
    if once:
        concurrency = 1
    print(
        f"Runner active — workspace {creds.workspace_id} @ {creds.base_url}. "
        + (
            "Draining one claim."
            if once
            else f"Watching for queued issues ({concurrency} in parallel)."
        )
    )

    # --once: process at most one cycle. Default: run forever.
    if once:
        ticks = {"n": 0}

        def should_continue() -> bool:
            ticks["n"] += 1
            return ticks["n"] <= 1

    else:
        def should_continue() -> bool:
            return True

    try:
        run_worker(
            client,
            execute=_make_execute(creds),
            sleep=time.sleep,
            idle_seconds=idle,
            should_continue=should_continue,
            concurrency=concurrency,
        )
    except KeyboardInterrupt:
        print("\nRunner stopped.")
    return 0
