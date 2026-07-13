"""
Asyncio orchestrator for the AFK workflow — the Python replacement for the
bash ``afk-workflow`` script.

Concurrency model: N worker coroutines pull from the single ``Store``. Claiming
is synchronous (``store.claim_next``) so two workers can never take the same
issue — the lock lives in local state, not in GitHub labels. GitHub label
writes are confirmation side effects layered on top.

Per-worker pipeline (ADR 0007):
  implement issue -> find PR -> advisory review (once, never blocks)
    -> objective gate (CI checks + security):
       -> pass : merge
       -> fail : bounded agent fix (max 2) in place, re-run gate
       -> still failing after the fix budget : escalate to human review
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import FrozenSet, List, Optional

from agentrail.afk import github as gh
from agentrail.afk import review as review_policy
from agentrail.afk.state import (
    AfkState,
    EnqueueIssue,
    IssueState,
    IssueStatus,
    RecordCost,
    RecordFailure,
    RequeueIssue,
    SetBlockedBy,
    SetPr,
    SetStatus,
    Store,
)
from agentrail.afk.journal import attach_journal
from agentrail.afk.store import attach_persistence, load_snapshot
from agentrail.afk.telemetry import attach_telemetry
from agentrail.run.push_guardrail import guard_push, make_server_emitter

HUMAN_REVIEW_LABEL = "human-review-needed"
IN_PROGRESS_LABEL = "afk-in-progress"
REVIEWED_LABEL = "pr-reviewed"


def _agent_command(engine: str, model: str = "") -> str:
    # The returned string is shell-evaluated (bash -lc) downstream, so the
    # model token is quoted — config values must never become shell code.
    import shlex
    quoted = shlex.quote(model) if model else ""
    if engine == "codex":
        base = "codex exec --sandbox danger-full-access -"
        return f"{base} -m {quoted}" if model else base
    base = "claude -p --dangerously-skip-permissions"
    return f"{base} --model {quoted}" if model else base


def _agentrail_runner(target: Path) -> str:
    """Resolve the local ``agentrail`` launcher for *target*, if one exists.

    Two conventions can apply here:
      - an installed CONSUMER project (ran ``agentrail install``) vendors the
        launcher at the top-level ``<target>/scripts/agentrail``;
      - the AgentRail SOURCE repo itself (dogfooding AFK on its own issues,
        ``AGENTRAIL_ALLOW_SOURCE_RUN=1`` — see dogfood-afk-run skill) carries
        its own launcher at ``<target>/agentrail/scripts/agentrail`` since the
        repo-structure-v2 move nested ``scripts/`` under the package.
    Check the source-repo path first, then the installed-target path, else
    fall back to whatever ``agentrail`` is on PATH.
    """
    for candidate in (
        target / "agentrail" / "scripts" / "agentrail",
        target / "scripts" / "agentrail",
    ):
        if candidate.exists():
            return str(candidate)
    return "agentrail"


async def _sh(args: List[str], cwd: Optional[Path] = None,
              log: Optional[Path] = None,
              env: Optional[dict] = None) -> int:
    """Run a subprocess off the event loop; tee combined output to ``log``."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    chunks: List[bytes] = []
    async for line in proc.stdout:
        chunks.append(line)
    rc = await proc.wait()
    if log is not None:
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_bytes(b"".join(chunks))
    return rc


def _read_run_cost(worktree: Path) -> float:
    """Sum the pipeline's per-phase cost ledger in ``worktree``.

    Mirrors the sandbox native_runner parser: the pipeline appends one JSON
    line per phase with a ``cost_usd`` field to ``.agentrail/run/cost-events.jsonl``.
    Best-effort — a missing or malformed ledger yields 0.0, never raises.
    """
    ledger = worktree / ".agentrail" / "run" / "cost-events.jsonl"
    import json as _json
    total = 0.0
    try:
        for line in ledger.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                total += float(_json.loads(line).get("cost_usd") or 0.0)
            except (ValueError, TypeError):
                pass
    except (FileNotFoundError, OSError):
        pass
    return total


class Runner:
    def __init__(self, target: Path, *, engine: str, base: str,
                 concurrency: int, afk_label: str, queue_labels: List[str],
                 run_dir: Path, store: Store, model: str = "",
                 budget_per_issue: float = 0.0) -> None:
        self.target = target
        self.engine = engine
        self.base = base
        self.model = model
        self.budget_per_issue = budget_per_issue
        self.concurrency = concurrency
        self.afk_label = afk_label
        self.queue_labels = queue_labels
        self.run_dir = run_dir
        self.store = store
        self.logs = run_dir / "logs"
        self.logs.mkdir(parents=True, exist_ok=True)
        self.agentrail = _agentrail_runner(target)
        # session_id is stashed on the store by build_store after attach_journal;
        # fall back to None so the runner is safe if constructed without it.
        self.session_id: Optional[str] = getattr(store, "_session_id", None)
        # Task 4 (langfuse-tracing-shadow-judge PRD): the runner's own start
        # time, fixed once per Runner instance (i.e. once per `agentrail afk`
        # invocation). Combined with the issue number in
        # `_langfuse_session_id`, it gives every AFK work-item (one GitHub
        # issue's implement phase) a Langfuse session id that stays constant
        # even if that phase is retried, while still being distinct from the
        # same issue reprocessed by a later `agentrail afk` run.
        from datetime import datetime, timezone
        self._start_iso = datetime.now(timezone.utc).isoformat()

    def _langfuse_session_id(self, issue: int) -> str:
        """Session id shared by every phase/retry of one AFK work-item.

        Consumed by Task 3's ``RunTracer.start(..., session_id=...)`` read of
        ``AGENTRAIL_LANGFUSE_SESSION_ID`` in ``agentrail/run/pipeline.py`` —
        so every ``agentrail run issue`` phase for this issue groups into one
        Langfuse session. Harmless metadata when Langfuse is disabled or the
        consuming command ignores it (e.g. review/objective-fix subprocesses
        that don't currently read this env var).
        """
        return f"afk-{issue}-{self._start_iso}"

    # --- worktree helpers ----------------------------------------------------

    def _worktree(self, slot: int, issue: int) -> Path:
        return self.run_dir / "worktrees" / f"slot-{slot}-issue-{issue}"

    def _setup_worktree(self, path: Path, ref: str) -> None:
        subprocess.run(["git", "-C", str(self.target), "fetch", "origin", self.base],
                       check=False, capture_output=True)
        subprocess.run(["git", "-C", str(self.target), "worktree", "add", "--detach",
                        str(path), ref], check=False, capture_output=True)
        # seed agentrail state into the worktree
        src_state = self.target / ".agentrail" / "state.json"
        dst_dir = path / ".agentrail"
        dst_dir.mkdir(parents=True, exist_ok=True)
        if src_state.exists() and not (dst_dir / "state.json").exists():
            shutil.copy(src_state, dst_dir / "state.json")
        src_cfg = self.target / ".agentrail" / "config.json"
        if src_cfg.exists() and not (dst_dir / "config.json").exists():
            shutil.copy(src_cfg, dst_dir / "config.json")
        # The dashboard link lives in the main checkout, but the pipeline runs with
        # --target=<worktree>; without server.json here its cost/context-pack pushes
        # (which read .agentrail/server.json from the target) silently no-op.
        src_link = self.target / ".agentrail" / "server.json"
        if src_link.exists() and not (dst_dir / "server.json").exists():
            shutil.copy(src_link, dst_dir / "server.json")
        # Seed the context-first enforcement hook (#519, claude-only) into the
        # worktree: copy .agentrail/hooks/ and .claude/settings.json if missing.
        # Do NOT seed .agentrail/tmp/ — fresh worktrees must start unmarked so the
        # session's first broad grep is gated until context retrieval runs.
        src_hook = self.target / ".agentrail" / "hooks" / "context-first.sh"
        if src_hook.exists() and not (dst_dir / "hooks" / "context-first.sh").exists():
            (dst_dir / "hooks").mkdir(parents=True, exist_ok=True)
            shutil.copy(src_hook, dst_dir / "hooks" / "context-first.sh")
            (dst_dir / "hooks" / "context-first.sh").chmod(0o755)
        src_settings = self.target / ".claude" / "settings.json"
        dst_settings = path / ".claude" / "settings.json"
        if src_settings.exists() and not dst_settings.exists():
            dst_settings.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(src_settings, dst_settings)

    def _remove_worktree(self, path: Path) -> None:
        subprocess.run(["git", "-C", str(self.target), "worktree", "remove",
                        "--force", str(path)], check=False, capture_output=True)

    # --- push guardrail (#773 wired at the real push seam, #781) -------------

    def _push_diff_content(self, wt: Path) -> str:
        """Return the content the about-to-be-pushed commit introduces.

        Used by the #773 secret guardrail to scan for secrets before the push.
        Hermetic and non-fatal: any git failure yields "" (scan sees nothing,
        the guardrail falls back to the protected-target check only) so a
        guardrail-internal error can never silently let a secret through *or*
        block a legitimate push.
        """
        proc = subprocess.run(
            ["git", "-C", str(wt), "show", "--format=", "HEAD"],
            check=False, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            return ""
        return proc.stdout or ""

    def _guarded_push(self, wt: Path, head: str, run_id: str = "") -> bool:
        """Push ``wt`` HEAD to ``origin HEAD:<head>`` through the #773 guardrail.

        The guardrail (secret detection + protected-target) is the real
        enforcement point #773 left as a follow-up. A block is audited (via the
        server emitter, non-fatal/no-network when unlinked) and the dangerous
        ``git push`` never runs. A clean push proceeds exactly as before, so the
        env-sensitive ``*_push`` tests and normal feature-branch pushes are
        unaffected.
        """
        decision = guard_push(
            targets=[head],
            content=self._push_diff_content(wt),
            emit=make_server_emitter(self.target, run_id),
            run_id=run_id,
        )
        if decision.blocked:
            return False
        push = subprocess.run(
            ["git", "-C", str(wt), "push", "origin", f"HEAD:{head}"],
            check=False, capture_output=True,
        )
        return push.returncode == 0

    # --- pipeline stages -----------------------------------------------------

    async def _implement(self, slot: int, issue: int) -> bool:
        wt = self._worktree(slot, issue)
        self._setup_worktree(wt, f"origin/{self.base}")
        cmd = [self.agentrail, "run", "issue", str(issue), "--agent", self.engine,
               "--target", str(wt)]
        if self.model:
            cmd += ["--model", self.model]
        # Always forward the resolved budget — run_afk has already applied the
        # flag > config > 0 precedence. Forwarding an explicit 0 matters: the
        # worktree carries a copy of .agentrail/config.json, so omitting the
        # flag would let `run issue` re-apply budgets.per_issue_usd from config
        # even when the user disabled the cap with --budget-per-issue 0.
        cmd += ["--budget-usd", str(self.budget_per_issue)]
        sid = getattr(self, "session_id", None)
        if sid:
            from agentrail.afk.run_register import run_uuid
            cmd += ["--run-id", run_uuid(sid, issue)]
        # Pass the dashboard link to the pipeline via env. The pipeline runs with
        # --target=<worktree>, which doesn't carry server.json, so its cost/
        # context-pack pushes resolve the link from these env vars instead.
        env = dict(os.environ)
        from agentrail.context.snapshot_push import load_link
        link = load_link(self.target)
        if link:
            env["AGENTRAIL_SERVER_BASE_URL"] = link["base_url"]
            env["AGENTRAIL_SERVER_API_KEY"] = link["api_key"]
            env["AGENTRAIL_SERVER_REPOSITORY_ID"] = link["repository_id"]
        # Task 4 (langfuse-tracing-shadow-judge PRD): propagate this item's
        # Langfuse session id so `run issue`'s pipeline.py RunTracer.start()
        # groups every phase of this issue's implement run into one session.
        # Unconditional — harmless metadata when Langfuse is disabled.
        env["AGENTRAIL_LANGFUSE_SESSION_ID"] = self._langfuse_session_id(issue)
        rc = await _sh(
            cmd,
            cwd=wt,
            log=self.logs / f"issue-{issue}-implement.log",
            env=env,
        )

        # Carry the run's real-dollar cost into the store so the finally-block in
        # _process re-reads it from final_issue and reports it via ingest even
        # when the run failed. The pipeline writes a per-phase cost ledger in the
        # worktree; read it whatever rc is — a failed run still spent money (and
        # PR A makes that cost nonzero on failures too).
        self.store.dispatch(RecordCost(issue, _read_run_cost(wt)))

        # Compute diff savings and append to the AFK journal (non-fatal).
        try:
            import datetime as _dt
            from agentrail.afk.diff_savings import collect_worktree_diff, estimate_output_savings
            from agentrail.afk.journal import _append, events_path
            entries = collect_worktree_diff(wt, self.base)
            savings = estimate_output_savings(entries, self.model or "")
            sid = getattr(self, "session_id", None)
            if sid:
                _append(
                    events_path(self.target),
                    {
                        "v": 1,
                        "kind": "cost_optimizer",
                        "session": sid,
                        "issue": issue,
                        "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
                        "payload": savings,
                    },
                )
        except Exception:  # noqa: BLE001 — non-fatal
            pass

        return rc == 0

    def _git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.target), *args],
                              check=False, capture_output=True, text=True)

    async def _review(self, pr: int) -> Optional[review_policy.ReviewOutcome]:
        head = gh.pr_head_ref(pr)
        if not head:
            return None
        # Review in a disposable worktree. review-pr does `git switch <head>` in
        # its cwd (resolved via `git rev-parse --show-toplevel`), so running it in
        # a worktree checks out the PR head THERE and never touches the main
        # checkout — this is what prevents the AFK data-loss.
        self._git("fetch", "origin", head)
        # drop any stale worktree already holding the head branch (but never the
        # main checkout itself)
        listing = self._git("worktree", "list", "--porcelain").stdout
        path: Optional[str] = None
        for line in listing.splitlines():
            if line.startswith("worktree "):
                path = line[len("worktree "):]
            elif line.startswith("branch ") and path:
                if line.endswith(f"/{head}") and path != str(self.target):
                    self._git("worktree", "remove", "--force", path)
        self._git("worktree", "prune")
        # force the local head branch to origin so review-pr's `git pull --ff-only`
        # is a no-op (a branch-ref update only; the main working tree is untouched)
        self._git("branch", "-f", head, f"origin/{head}")
        wt = self.run_dir / "worktrees" / f"review-pr-{pr}"
        if self._git("worktree", "add", str(wt), head).returncode != 0:
            return None
        try:
            out = self.logs / f"pr-{pr}-review.md"
            rc = await _sh(
                [self.agentrail, "internal", "review-pr", "--pr", str(pr),
                 "--engine", self.engine, "--output", str(out), "--machine-readable"],
                cwd=wt,
                log=self.logs / f"pr-{pr}-review.log",
            )
            if rc != 0:
                return None
            return review_policy.classify(out)
        finally:
            self._remove_worktree(wt)

    async def _objective_gate(self, pr: int):
        """Poll CI until checks resolve, then run the deterministic gate."""
        from agentrail.afk import objective_gate as og

        checks: list[dict] = []
        for _ in range(60):  # ~5 min at 5s
            checks = gh.pr_checks(pr)
            ci = og.evaluate_ci(checks)
            if ci is None or ci.state != "pending":
                break
            await asyncio.sleep(5)

        added, deleted = self._pr_diff(pr)
        references = self._references_for(deleted)
        return og.evaluate(checks=checks, added_lines=added,
                           deleted_files=deleted, references=references)

    def _pr_diff(self, pr: int) -> tuple[list[str], list[str]]:
        """Return (added diff lines, deleted file paths) for the PR vs base."""
        head = gh.pr_head_ref(pr)
        self._git("fetch", "origin", head)
        diff = self._git("diff", f"origin/{self.base}...origin/{head}").stdout
        added = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
        names = self._git("diff", "--diff-filter=D", "--name-only",
                          f"origin/{self.base}...origin/{head}").stdout
        deleted = [n for n in names.splitlines() if n.strip()]
        return added, deleted

    def _references_for(self, deleted: list[str]) -> dict[str, list[str]]:
        """For each deleted file, grep the tree for files still referencing it."""
        refs: dict[str, list[str]] = {}
        for path in deleted:
            stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if not stem:
                refs[path] = []
                continue
            proc = self._git("grep", "-l", "-w", stem)
            hits = [h for h in proc.stdout.splitlines() if h and h != path]
            refs[path] = hits
        return refs

    async def _objective_fix(self, slot: int, issue: int, pr: int, gate) -> bool:
        """Hand the objective failures to the agent to fix in place (bounded by caller)."""
        from agentrail.afk import objective_gate as og
        head = gh.pr_head_ref(pr)
        if not head:
            return False
        wt = self.run_dir / "worktrees" / f"objfix-pr-{pr}"
        subprocess.run(["git", "-C", str(self.target), "fetch", "origin", head],
                       check=False, capture_output=True)
        subprocess.run(["git", "-C", str(self.target), "worktree", "add",
                        str(wt), f"origin/{head}"], check=False, capture_output=True)
        try:
            prompt = og.fix_prompt(pr, gate.reasons)
            prompt_file = self.logs / f"pr-{pr}-objfix-prompt.txt"
            prompt_file.write_text(prompt)
            cmd = _agent_command(self.engine, self.model)
            rc = await _sh(["bash", "-lc", f"{cmd} < {prompt_file}"], cwd=wt,
                          log=self.logs / f"pr-{pr}-objfix.log")
            if rc != 0:
                return False
            subprocess.run(["git", "-C", str(wt), "add", "-A"], check=False, capture_output=True)
            subprocess.run(["git", "-C", str(wt), "commit", "--no-verify", "-m",
                            f"fix: resolve objective-gate failures for PR #{pr}"],
                           check=False, capture_output=True)
            run_id = getattr(self, "session_id", "") or ""
            return self._guarded_push(wt, head=head, run_id=run_id)
        finally:
            self._remove_worktree(wt)

    def _push_gate(self, issue: int, pr: int, gate, review_text: str, round_no: int) -> None:
        sid = getattr(self, "session_id", None)
        if not sid:
            return
        from agentrail.afk.review_push import push_review_gate
        from agentrail.afk.run_register import run_uuid
        push_review_gate(self.target, run_uuid(sid, issue), round_no, gate, review_text=review_text)

    def _escalate_human(self, issue: int, pr: int, reasons: list[str]) -> None:
        gh.ensure_label(HUMAN_REVIEW_LABEL, "D4C5F9",
                        "PR needs human review — objective gate failed.")
        gh.add_pr_label(pr, HUMAN_REVIEW_LABEL)
        if reasons:
            gh.comment_on_pr(pr, "## Objective gate blocked merge\n\n"
                             + "\n".join(f"- {r}" for r in reasons))
        self.store.dispatch(SetStatus(issue, IssueStatus.HUMAN_REVIEW))
        self._cleanup_issue_labels(issue)

    async def _merge(self, pr: int) -> bool:
        ok, _ = gh.merge_pr_squash(pr, f"AFK merge PR #{pr}")
        return ok

    # --- per-issue driver ----------------------------------------------------

    async def _process(self, slot: int, issue_state: IssueState) -> None:
        issue = issue_state.number
        self._register_run(issue_state, "running", started=True)
        gh.add_issue_label(issue, IN_PROGRESS_LABEL)

        _FINISH_STATUS_MAP = {
            IssueStatus.MERGED: "success",
            IssueStatus.COMMENTED: "success",
            IssueStatus.HUMAN_REVIEW: "success",
            IssueStatus.FAILED: "failed",
        }

        try:
            # Idempotency: if a PR already exists for this issue (a retry after a
            # failed review, or a resumed run), do NOT re-implement — that would
            # collide with the existing branch/worktree. Go straight to review.
            pr = issue_state.pr or gh.detect_pr_for_issue(issue)
            if pr:
                self.store.dispatch(SetPr(issue, pr))
                self.store.dispatch(SetStatus(issue, IssueStatus.PR_OPEN))
                await self._review_and_gate(slot, issue, pr)
                return

            self.store.dispatch(SetStatus(issue, IssueStatus.RUNNING))
            ok = await self._implement(slot, issue)
            if not ok:
                self._fail(issue, "implementation failed")
                return

            pr = gh.detect_pr_for_issue(issue)
            if not pr:
                self._fail(issue, "no PR opened")
                return
            self.store.dispatch(SetPr(issue, pr))
            self.store.dispatch(SetStatus(issue, IssueStatus.PR_OPEN))

            await self._review_and_gate(slot, issue, pr)
        finally:
            final_issue = self.store.state.issues.get(issue)
            if final_issue is not None:
                run_status = _FINISH_STATUS_MAP.get(final_issue.status, "failed")
                self._register_run(final_issue, run_status, finished=True)

    async def _review_and_gate(self, slot: int, issue: int, pr: int) -> None:
        max_fix = 2

        # 1. Advisory review — runs once, never blocks (ADR 0007).
        self.store.dispatch(SetStatus(issue, IssueStatus.REVIEWING))
        outcome = await self._review(pr)
        if outcome is None:
            self._fail(issue, "review produced no parseable output")
            return

        review_file = self.logs / f"pr-{pr}-review.md"
        try:
            review_text = review_file.read_text()
        except OSError:
            review_text = ""

        if outcome.has_findings:
            gh.comment_on_pr(pr, review_policy.findings_comment(pr, outcome))

        # Memory suggestions flow once per review (parity with the old loop).
        sid = getattr(self, "session_id", None)
        if sid:
            from agentrail.afk.review_push import push_memory_items
            from agentrail.afk.run_register import run_uuid
            push_memory_items(self.target, run_uuid(sid, issue), outcome)

        # 2. Objective gate, with a bounded fix loop.
        attempts = 0
        while True:
            gate = await self._objective_gate(pr)
            self._push_gate(issue, pr, gate, review_text, round_no=attempts + 1)

            if gate.passed:
                if await self._merge(pr):
                    self.store.dispatch(SetStatus(issue, IssueStatus.MERGED))
                    self._cleanup_issue_labels(issue)
                else:
                    self._fail(issue, "merge failed")
                return

            if attempts >= max_fix:
                self._escalate_human(issue, pr, gate.reasons)
                return

            attempts += 1
            self.store.dispatch(SetStatus(issue, IssueStatus.AUTOFIXING))
            fixed = await self._objective_fix(slot, issue, pr, gate)
            if not fixed:
                self._escalate_human(issue, pr, gate.reasons)
                return
            # loop: re-run the objective gate after the fix

    # --- helpers -------------------------------------------------------------

    def _register_run(self, issue_state: IssueState, status: str, *,
                      started: bool = False, finished: bool = False) -> None:
        try:
            from agentrail.afk.run_register import run_uuid, register_run
            from datetime import datetime, timezone
            sid = getattr(self, "session_id", None)
            if not sid:
                return
            now = datetime.now(timezone.utc).isoformat()
            # Remember the start time so the finish upsert can carry it too —
            # if the start registration was lost (server briefly down), the
            # run would otherwise never get a started_at, and duration on the
            # dashboard stays blank forever.
            if not hasattr(self, "_run_starts"):
                self._run_starts: dict[int, str] = {}
            if started:
                self._run_starts[issue_state.number] = now
            started_at = now if started else (
                self._run_starts.get(issue_state.number) if finished else None
            )
            branch = f"afk/issue-{issue_state.number}"
            pr = getattr(issue_state, "pr", None)
            if pr:
                rc = subprocess.run(
                    ["gh", "pr", "view", str(pr), "--json", "headRefName", "-q", ".headRefName"],
                    cwd=str(self.target), capture_output=True, text=True, check=False,
                )
                if rc.returncode == 0 and rc.stdout.strip():
                    branch = rc.stdout.strip()
            register_run(
                self.target,
                run_id=run_uuid(sid, issue_state.number),
                agent=self.engine,
                branch=branch,
                title=issue_state.title or f"Issue #{issue_state.number}",
                status=status,
                started_at=started_at,
                finished_at=now if finished else None,
                # Last-known cost held in the issue state (set by _implement via
                # RecordCost). Because the finally-block reads final_issue from
                # the store before calling here, cost is reported even on failure.
                cost_usd=getattr(issue_state, "cost_usd", 0.0) or 0.0,
            )
        except Exception:  # noqa: BLE001 — non-fatal
            pass

    def _fail(self, issue: int, reason: str) -> None:
        self.store.dispatch(RecordFailure(issue, reason))
        # Push failure telemetry — non-fatal.
        try:
            from agentrail.run.failure_push import push_failure_event
            from agentrail.afk.run_register import run_uuid
            sid = getattr(self, "session_id", None)
            if sid:
                # Attach the implement-log tail as evidence. push_failure_event
                # tails, secret-scrubs and byte-caps it before send.
                evidence = ""
                try:
                    log_file = self.logs / f"issue-{issue}-implement.log"
                    if log_file.exists():
                        evidence = log_file.read_text(encoding="utf-8", errors="replace")
                except Exception:  # noqa: BLE001 — evidence is best-effort
                    evidence = ""
                push_failure_event(
                    self.target,
                    run_id=run_uuid(sid, issue),
                    failure_type="afk_failure",
                    phase="afk",
                    message=reason,
                    evidence=evidence,
                )
        except Exception:  # noqa: BLE001 — non-fatal
            pass
        status = self.store.state.issues[issue].status
        if status == IssueStatus.HUMAN_REVIEW:
            pr = self.store.state.issues[issue].pr
            if pr:
                gh.ensure_label(HUMAN_REVIEW_LABEL, "D4C5F9",
                                "PR needs human review — automated review failed repeatedly.")
                gh.add_pr_label(pr, HUMAN_REVIEW_LABEL)
            self._cleanup_issue_labels(issue)

    def _cleanup_issue_labels(self, issue: int) -> None:
        gh.remove_issue_label(issue, IN_PROGRESS_LABEL)
        gh.add_issue_label(issue, REVIEWED_LABEL)

    # --- workers -------------------------------------------------------------

    async def _open_blockers(self, *, force: bool = False) -> FrozenSet[int]:
        """Set of blocker issue numbers (across the queue) that are still OPEN.

        Cached for ~15s so a tight claim loop doesn't hammer ``gh``. An issue is
        withheld from claiming while any of its ``blocked_by`` is in this set.
        Fails open (empty set) if ``gh`` errors, so a transient GitHub blip
        degrades to the old non-dependency-aware behaviour rather than stalling.
        """
        universe = self._blocker_universe
        if not universe:
            return frozenset()
        now = time.monotonic()
        if force or (now - self._ob_ts) > 15.0:
            try:
                self._ob_cache = frozenset(
                    await asyncio.to_thread(gh.open_issue_numbers, universe)
                )
            except Exception:  # noqa: BLE001 - fail open
                self._ob_cache = frozenset()
            self._ob_ts = now
        return self._ob_cache

    def _log_blocked_stall(self, state: AfkState, open_blockers: FrozenSet[int]) -> None:
        blocked = [
            (i.number, sorted(set(i.blocked_by) & open_blockers))
            for i in state.issues.values()
            if i.status == IssueStatus.QUEUED and (set(i.blocked_by) & open_blockers)
        ]
        detail = "; ".join(f"#{n} waits on {b}" for n, b in sorted(blocked))
        print(
            "AFK: remaining issues are blocked by still-open issues and nothing "
            f"is in flight to unblock them — stopping. {detail}",
            flush=True,
        )

    async def _worker(self, slot: int) -> None:
        while True:
            open_blockers = await self._open_blockers()
            claimed = self.store.claim_next(open_blockers)
            if claimed is None:
                state = self.store.state
                # fully done?
                if state.is_drained():
                    return
                # If nothing is in flight but issues remain queued, they must be
                # withheld by open blockers. Re-check blockers fresh (the cache
                # may be stale right after a blocker merged) before giving up.
                if state.active_count() == 0 and state.next_queued() is not None:
                    fresh = await self._open_blockers(force=True)
                    claimed = self.store.claim_next(fresh)
                    if claimed is None:
                        self._log_blocked_stall(state, fresh)
                        return
                else:
                    await asyncio.sleep(1)
                    continue
            try:
                await self._process(slot, claimed)
            except Exception as exc:  # noqa: BLE001
                self._fail(claimed.number, f"worker exception: {exc}")

    async def run(self) -> AfkState:
        # Universe of blocker issue numbers referenced across the queue, used to
        # batch-resolve which blockers are still open (see _open_blockers).
        self._blocker_universe: FrozenSet[int] = frozenset(
            b for i in self.store.state.issues.values() for b in i.blocked_by
        )
        self._ob_cache: FrozenSet[int] = frozenset()
        self._ob_ts: float = -1.0e9
        workers = [asyncio.create_task(self._worker(s))
                   for s in range(self.concurrency)]
        await asyncio.gather(*workers)
        try:
            from agentrail.afk.telemetry import flush_afk_events, load_server_config
            config = load_server_config(self.target)
            if config is not None:
                flush_afk_events(config, self.target)
        except Exception:  # noqa: BLE001
            pass
        return self.store.state


def build_store(target: Path, *, concurrency: int, max_retries: int,
                max_review_rounds: int, issues: List[dict]) -> Store:
    """Create (or resume) the store and seed the queue from GitHub issues."""
    existing = load_snapshot(target)
    if existing is not None:
        # resume: keep terminal issues, refresh config knobs
        from dataclasses import replace as _replace
        base = _replace(existing, concurrency=concurrency,
                        max_retries=max_retries, max_review_rounds=max_review_rounds)
    else:
        base = AfkState(concurrency=concurrency, max_retries=max_retries,
                        max_review_rounds=max_review_rounds,
                        slots={i: None for i in range(concurrency)})
    # a fresh run starts with all slots empty regardless of how a prior run left them
    from dataclasses import replace as _replace
    base = _replace(base, slots={i: None for i in range(concurrency)})
    store = Store(base)
    attach_persistence(store, target)
    # Flight recorder: append every dispatch to an event journal so the run can
    # be replayed deterministically and inspected with `agentrail timeline`.
    session_id = attach_journal(store, target)
    # Telemetry poster: ship each action to the AgentRail server when configured.
    attach_telemetry(store, target, session_id)
    store._session_id = session_id  # expose for Runner.session_id wiring
    for item in issues:
        num = item["number"]
        blocked_by = tuple(item.get("blocked_by") or ())
        existing_issue = store.state.issues.get(num)
        if existing_issue is None:
            store.dispatch(EnqueueIssue(num, item.get("title", ""),
                                        item.get("url", ""), blocked_by=blocked_by))
        else:
            # Refresh blockers from the freshly-parsed body (handles snapshots
            # written before dependency-awareness existed, or re-scoped deps).
            store.dispatch(SetBlockedBy(num, blocked_by))
            if existing_issue.status != IssueStatus.QUEUED:
                # The issue is still open in the GitHub queue but the saved
                # snapshot has it in some non-queued state — either terminal
                # (human_review / merged) or an in-flight state (reviewing /
                # running) orphaned by a killed run. On a fresh process nothing
                # is actually in flight, so reset it for a clean attempt
                # (RequeueIssue keeps the PR ref, so the pipeline reviews the
                # existing PR rather than re-implementing).
                store.dispatch(RequeueIssue(num))
    return store
