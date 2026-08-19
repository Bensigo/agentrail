"""Server-selected dispatch for bounded dependency evidence producers."""
from __future__ import annotations

import json
import re
import urllib.parse
from typing import Optional

from agentrail.dependencies.acceptance_pnpm_observation_worker import (
    CommandResult,
    DescriptorError,
    HttpRequest,
    HttpResponse,
    PnpmObservationWorker,
    WorkerConfig,
    WorkerError,
    bounded_version_command,
)


# Go claims may carry a source-free recursive inventory receipt up to the
# existing 16 MiB custody bound. The dispatcher must admit that response before
# it knows which exact server-selected profile owns it.
MAX_CLAIM_BYTES = 16 * 1024 * 1024 + 64 * 1024
GO_IDENTITY = {
    "ecosystem": "go",
    "manager": "go-modules",
    "profile": "go_root_public_proxy_lock_v1",
}
PNPM_IDENTITY = {
    "ecosystem": "node",
    "manager": "pnpm",
    "profile": "pnpm_lockfile_only_v1",
}
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _valid_text(value: object, maximum: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum and value == value.strip() \
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)


class ServerSelectedObservationWorker:
    """Claim once, then dispatch only the exact profile selected by the server."""

    def __init__(
        self,
        config: WorkerConfig,
        *,
        request: HttpRequest,
        run_command,
        sumdb_transport=None,
    ) -> None:
        parsed = urllib.parse.urlsplit(config.console_url)
        loopback_http = parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (parsed.scheme != "https" and not loopback_http) or not parsed.netloc \
                or parsed.username or parsed.password or parsed.query or parsed.fragment \
                or not UUID.fullmatch(config.workspace_id) \
                or not _valid_text(config.workspace_api_key, 4096) \
                or not _valid_text(config.worker_id, 128):
            raise ValueError("worker configuration is invalid")
        self.config = WorkerConfig(
            config.console_url.rstrip("/"), config.workspace_api_key,
            config.workspace_id.lower(), config.worker_id,
        )
        self.request = request
        self.run_command = run_command
        self.sumdb_transport = sumdb_transport

    def run_once(self) -> str:
        claim_url = self.config.console_url.rstrip("/") + "/api/v1/runner/acceptance-dependency-observation-work/claim"
        claim_body = json.dumps({
            "workerId": self.config.worker_id,
        }, separators=(",", ":")).encode()
        claim = self.request(
            "POST",
            claim_url,
            {
                "authorization": f"Bearer {self.config.workspace_api_key}",
                "content-type": "application/json",
                "user-agent": "AgentRail-dependency-evidence/1",
            },
            claim_body,
            MAX_CLAIM_BYTES,
        )
        if claim.status == 204:
            return "idle"
        if claim.status != 200 or claim.final_url != claim_url or len(claim.body) > MAX_CLAIM_BYTES:
            raise WorkerError(f"dependency observation claim failed with status {claim.status}")
        try:
            raw_descriptor = json.loads(claim.body)
            identity = raw_descriptor["candidate"]["identity"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
            raise DescriptorError("claim descriptor has no server-selected profile") from exc

        consumed = False

        def request_with_claim(
            method: str,
            url: str,
            headers: dict[str, str],
            body: Optional[bytes],
            max_bytes: int,
        ) -> HttpResponse:
            nonlocal consumed
            if method == "POST" and url == claim_url and not consumed:
                consumed = True
                return claim
            return self.request(method, url, headers, body, max_bytes)

        if identity == GO_IDENTITY:
            # Keep the pinned-key verifier and its crypto dependency outside
            # generic CLI/help and pnpm-only execution paths.
            from agentrail.dependencies.acceptance_go_modules_observation_worker import (
                GoModulesObservationWorker,
            )

            selected = GoModulesObservationWorker(
                self.config,
                request=request_with_claim,
                run_command=self.run_command,
                sumdb_transport=self.sumdb_transport,
            )
        elif identity == PNPM_IDENTITY:
            selected = PnpmObservationWorker(
                self.config,
                request=request_with_claim,
                run_command=self.run_command,
            )
        else:
            raise DescriptorError("server selected an unsupported observation profile")
        return selected.run_once()


def bounded_dependency_version_command(argv: tuple[str, ...]) -> CommandResult:
    """Dispatch only version probes authorized by an admitted worker profile."""
    if argv == ("go", "version"):
        from agentrail.dependencies.acceptance_go_modules_observation_worker import (
            bounded_go_version_command,
        )

        return bounded_go_version_command(argv)
    return bounded_version_command(argv)


__all__ = [
    "ServerSelectedObservationWorker",
    "bounded_dependency_version_command",
]
