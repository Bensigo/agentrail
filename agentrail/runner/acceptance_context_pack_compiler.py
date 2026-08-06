"""Compile one claimed Acceptance Record Context Pack in a disposable checkout.

This is deliberately separate from onboarding and the code factory. It claims
only a confirmed-contract/repository/ref tuple, clones that ref, builds the
local index, compiles one bounded ``acceptance_record`` Pack, reduces it to
metadata, reports it, and removes every local source artifact in ``finally``.
It never selects a builder, edits code, creates a PR, or merges.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from agentrail.context.acceptance_manifest import acceptance_context_manifest
from agentrail.context.index import build_index
from agentrail.context.packs import build_context_pack, load_context_pack
from agentrail.runner.client import Response, Transport, _urllib_transport
from agentrail.runner.onboard import _clone
from agentrail.sandbox.clone_auth import redact_token

_log = logging.getLogger("agentrail.runner.acceptance_context_pack_compiler")

ENABLED_ENV = "ACCEPTANCE_CONTEXT_PACK_COMPILER_ENABLED"
BASE_URL_ENV = "AGENTRAIL_SERVER_BASE_URL"
TOKEN_ENV = "JACE_CONSOLE_TOKEN"
CLAIM_PATH = "/api/v1/runner/acceptance-context-pack-compilations/claim"
COMPLETE_PATH = "/api/v1/runner/acceptance-context-pack-compilations/{id}/complete"
_REASON_MAX_CHARS = 2000


@dataclass(frozen=True)
class WorkerConfig:
    base_url: str
    token: str
    worker_id: str


@dataclass(frozen=True)
class ClaimedCompilation:
    id: str
    record_id: str
    phase: str
    repo_url: str
    ref: str
    github_token: str
    contract: Dict[str, Any]


def _headers(config: WorkerConfig) -> Dict[str, str]:
    return {"Authorization": f"Bearer {config.token}", "Content-Type": "application/json"}


def _claim(transport: Transport, config: WorkerConfig) -> Optional[ClaimedCompilation]:
    response = transport(
        "POST",
        f"{config.base_url.rstrip('/')}{CLAIM_PATH}",
        headers=_headers(config),
        body=json.dumps({"workerId": config.worker_id}).encode("utf-8"),
    )
    if response.status == 204:
        return None
    if response.status != 200 or not response.body:
        raise RuntimeError(f"Context Pack compilation claim failed: HTTP {response.status}")
    raw = json.loads(response.body.decode("utf-8"))
    compilation = raw.get("compilation") if isinstance(raw, dict) else None
    repository = raw.get("repository") if isinstance(raw, dict) else None
    contract = raw.get("contract") if isinstance(raw, dict) else None
    if not all(isinstance(value, dict) for value in (compilation, repository, contract)):
        raise RuntimeError("Context Pack compilation claim has malformed bindings")
    item = ClaimedCompilation(
        id=str(compilation.get("id") or ""),
        record_id=str(compilation.get("recordId") or ""),
        phase=str(compilation.get("phase") or ""),
        repo_url=str(repository.get("url") or ""),
        ref=str(repository.get("ref") or ""),
        github_token=str(raw.get("githubToken") or ""),
        contract=contract.get("contract") if isinstance(contract.get("contract"), dict) else {},
    )
    if not all((item.id, item.record_id, item.phase, item.repo_url, item.ref, item.contract)):
        raise RuntimeError("Context Pack compilation claim is missing exact bindings")
    return item


def _bounded_reason(exc: Exception, token: str) -> str:
    return redact_token(str(exc), token).strip()[:_REASON_MAX_CHARS] or "Context Pack compilation failed"


def _report(
    transport: Transport,
    config: WorkerConfig,
    item: ClaimedCompilation,
    payload: Dict[str, Any],
) -> bool:
    response = transport(
        "POST",
        f"{config.base_url.rstrip('/')}{COMPLETE_PATH.format(id=item.id)}",
        headers=_headers(config),
        body=json.dumps({"workerId": config.worker_id, **payload}).encode("utf-8"),
    )
    return 200 <= response.status < 300


def compile_claim(
    item: ClaimedCompilation,
    config: WorkerConfig,
    *,
    transport: Transport,
    clone_fn: Callable[..., None] = _clone,
    index_fn: Callable[[Path], Any] = build_index,
    compile_fn: Callable[..., Dict[str, Any]] = build_context_pack,
    load_pack_fn: Callable[[Path, str], Dict[str, Any]] = load_context_pack,
    manifest_fn: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Dict[str, Any]]] = acceptance_context_manifest,
    work_dir_factory: Callable[[], str] = lambda: tempfile.mkdtemp(prefix="agentrail-acceptance-pack-"),
) -> bool:
    """Compile and report one claim, deleting its checkout on every outcome."""
    work_dir = Path(work_dir_factory())
    repo_dir = work_dir / "repo"
    try:
        clone_fn(item.repo_url, item.ref, str(repo_dir), token=item.github_token)
        shutil.rmtree(repo_dir / ".agentrail" / "context" / "index", ignore_errors=True)
        index_fn(repo_dir)
        result = compile_fn(
            repo_dir,
            "acceptance_record",
            item.record_id,
            item.phase,
            acceptance_contract=item.contract,
            run_id=item.id,
        )
        pack_id = result.get("packId") if isinstance(result, dict) else None
        if not isinstance(pack_id, str) or not pack_id:
            raise RuntimeError("Context Pack compiler did not return a pack id")
        durable = manifest_fn(load_pack_fn(repo_dir, pack_id), item.contract)
        manifest, custody, freshness = durable.get("manifest"), durable.get("custody"), durable.get("freshness")
        if not all(isinstance(value, dict) for value in (manifest, custody, freshness)):
            raise RuntimeError("Context Pack compiler did not produce durable metadata")
        payload = {
            "status": "compiled",
            "compilerVersion": result.get("compilerVersion"),
            "contentHash": result.get("contentHash"),
            "manifest": manifest,
            "custody": custody,
            "freshness": freshness,
            # The clone is destroyed after this call; raw local artifacts are
            # intentionally not retained in the central database yet.
            "jsonArtifactRef": None,
            "markdownArtifactRef": None,
        }
        return _report(transport, config, item, payload)
    except Exception as exc:  # noqa: BLE001 - every failure is a durable, bounded result
        _log.warning("acceptance Context Pack compilation failed for %s: %s", item.id, _bounded_reason(exc, item.github_token))
        return _report(transport, config, item, {"status": "failed", "reason": _bounded_reason(exc, item.github_token)})
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def run_once(config: WorkerConfig, *, transport: Transport = _urllib_transport, **kwargs: Any) -> bool:
    """Claim and process at most one job. ``False`` means an empty queue."""
    item = _claim(transport, config)
    return False if item is None else compile_claim(item, config, transport=transport, **kwargs)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="claim and process at most one job")
    args = parser.parse_args(argv)
    if os.environ.get(ENABLED_ENV) != "1":
        _log.info("acceptance Context Pack compiler disabled; set %s=1", ENABLED_ENV)
        return 0
    base_url, token = os.environ.get(BASE_URL_ENV, "").strip(), os.environ.get(TOKEN_ENV, "").strip()
    if not base_url or not token:
        raise SystemExit(f"{BASE_URL_ENV} and {TOKEN_ENV} are required")
    config = WorkerConfig(base_url=base_url, token=token, worker_id=os.environ.get("HOSTNAME", "acceptance-context-pack-worker"))
    if not args.once:
        raise SystemExit("only --once is supported until worker supervision is configured")
    run_once(config)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
