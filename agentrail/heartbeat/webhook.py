"""GitHub issue **webhook** receiver — trigger the loop from real events.

The Heartbeat can be fed two ways: it can *poll* GitHub on a cadence
(``poll_and_dispatch``), or it can react to a delivered **webhook** — the event
IS the issue, so there is nothing to poll. This module is the webhook side: a
tiny stdlib HTTP receiver that accepts GitHub ``issues`` events, and when an
issue is labeled with the connector's trigger label, ingests it into the Issue
Queue and dispatches it through the same cheap→strong escalation loop.

Locally, GitHub deliveries are forwarded to this receiver with::

    gh webhook forward --repo <owner/name> --events issues \\
        --url http://localhost:<port>/webhook

(or smee.io). No public ingress, no new dependency: ``gh webhook forward`` POSTs
each delivery to ``http://localhost:<port>/webhook``.

Two layers, mirroring the rest of the heartbeat:

1. :func:`handle_event` — the **pure-ish** handler. Every edge (the queue store,
   the runtime, the connector config, the ingest gate) is INJECTED, so the whole
   admit→enqueue→dispatch decision is hermetically testable with fakes — no
   network, no Docker, no DB.
2. :class:`WebhookServer` — the thin :mod:`http.server` wrapper that wires the
   ``POST /webhook`` route (with optional HMAC signature verification) to
   :func:`handle_event` with the real adapters. Constructed only by the CLI
   (``agentrail heartbeat serve``).

Reuse, never re-implement: the trigger label/repos come from
``afk/connectors_store`` (the same connector config the polling daemon reads),
enqueue + dedupe come from ``afk/queue_store.QueueStore.enqueue`` (idempotent on
``external_id``), and dispatch reuses ``HeartbeatRuntime.dispatch_pending`` — the
poll-free drain through the same escalation dispatch as ``poll_and_dispatch``.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional, Protocol

from agentrail.afk.input_contract import Rejected
from agentrail.connectors.base import IssueRef

# GitHub ``issues`` event actions that should (re)admit work. Other actions
# (closed, assigned, edited, …) are deliberately ignored — they do not change
# whether the issue is ready for the loop.
_TRIGGER_ACTIONS = frozenset({"opened", "reopened", "labeled"})

# The header GitHub sends the HMAC-SHA256 signature in (sha256=<hexdigest>).
SIGNATURE_HEADER = "X-Hub-Signature-256"
WEBHOOK_SECRET_ENV = "GITHUB_WEBHOOK_SECRET"


# --------------------------------------------------------------------------- #
# Injected edges (Protocols — any duck-typed fake/real adapter satisfies them)
# --------------------------------------------------------------------------- #
class _Store(Protocol):
    def enqueue(self, *, workspace_id, source, external_id, title, body,
                blocked_by=frozenset()):  # pragma: no cover
        ...


class _Runtime(Protocol):
    def dispatch_pending(self, workspace_id, refs_by_number=None):  # pragma: no cover
        ...


class _ConnectorConfig(Protocol):
    trigger_label: str


# The admission gate seam: build an admitted entry (or Rejected) from the issue
# body. Defaults to the input-contract gate so an issue without machine-checkable
# AC never enters the queue — the same gate the polling intake uses.
Ingest = Callable[..., Any]


def _default_ingest(*, number: int, body: str, blocked_by=frozenset()):
    """The default admission gate: the pure input-contract check (reused)."""
    from agentrail.afk.input_contract import admit_to_queue

    return admit_to_queue(number=number, issue_body=body, blocked_by=blocked_by)


# --------------------------------------------------------------------------- #
# EventResult — what handle_event did with one delivery
# --------------------------------------------------------------------------- #
@dataclass
class EventResult:
    """The outcome of handling one webhook delivery (the server logs these)."""

    matched: bool = False     # action + trigger label matched
    enqueued: int = 0         # issues admitted into the queue (0 if deduped/rejected)
    dispatched: int = 0       # entries the dispatch loop drained
    reason: str = ""          # why it was ignored / rejected (for logs)

    @classmethod
    def ignored(cls, reason: str) -> "EventResult":
        return cls(matched=False, reason=reason)


# --------------------------------------------------------------------------- #
# The pure-ish handler (AC1 / AC2)
# --------------------------------------------------------------------------- #
def handle_event(
    payload: Dict[str, Any],
    *,
    workspace_id: str,
    store: _Store,
    runtime: _Runtime,
    connector_config: _ConnectorConfig,
    ingest: Ingest = _default_ingest,
) -> EventResult:
    """Handle one decoded GitHub ``issues`` webhook payload.

    Admits + dispatches exactly when BOTH hold (AC1):

    - ``payload['action']`` is one of :data:`_TRIGGER_ACTIONS`
      (opened / reopened / labeled), AND
    - the issue carries a label whose name equals
      ``connector_config.trigger_label``.

    On a match it builds an :class:`IssueRef` from ``payload['issue']`` +
    ``payload['repository']['full_name']``, runs the body through the injected
    ``ingest`` admission gate, ``store.enqueue(...)`` (idempotent dedupe on
    ``external_id = repo#number``), then ``runtime.dispatch_pending(...)`` to
    drain the queue through the escalation loop. A non-matching action or label
    (AC2) is a no-op: no enqueue, no dispatch.
    """
    action = payload.get("action")
    if action not in _TRIGGER_ACTIONS:
        return EventResult.ignored(f"action {action!r} not a trigger action")

    issue = payload.get("issue")
    if not isinstance(issue, dict):
        return EventResult.ignored("payload has no issue object")

    label_names = _label_names(issue)
    if connector_config.trigger_label not in label_names:
        return EventResult.ignored(
            f"trigger label {connector_config.trigger_label!r} not on issue"
        )

    repo = _repo_full_name(payload)
    number = int(issue.get("number", 0))
    ref = IssueRef(
        repo=repo,
        number=number,
        title=issue.get("title") or "",
        body=issue.get("body") or "",
        url=issue.get("html_url") or "",
    )
    external_id = f"{repo}#{number}"

    # Admission gate (reused): an issue without machine-checkable AC never enters
    # the queue. QueueStore.enqueue runs the same gate, but checking here lets us
    # report the rejection reason without a second (deduped) enqueue side effect.
    admission = ingest(number=number, body=ref.body)
    if isinstance(admission, Rejected):
        return EventResult(
            matched=True, reason=f"rejected: {admission.missing_ac}"
        )

    admitted = store.enqueue(
        workspace_id=workspace_id,
        source="github",
        external_id=external_id,
        title=ref.title,
        body=ref.body,
    )
    if isinstance(admitted, Rejected):
        # Dedupe / gate at the store: nothing new to dispatch from this delivery,
        # but drain anyway so a previously-stuck queue still makes progress.
        result = EventResult(matched=True, reason="deduped or gated at store")
        report = runtime.dispatch_pending(workspace_id)
        result.dispatched = getattr(report, "dispatched", 0)
        return result

    refs_by_number = {admitted.number: ref}
    report = runtime.dispatch_pending(workspace_id, refs_by_number)
    return EventResult(
        matched=True,
        enqueued=1,
        dispatched=getattr(report, "dispatched", 0),
    )


def _label_names(issue: Dict[str, Any]) -> frozenset:
    """The set of label names on the issue payload (``issue['labels'][].name``)."""
    labels = issue.get("labels")
    if not isinstance(labels, list):
        return frozenset()
    names = set()
    for lab in labels:
        if isinstance(lab, dict) and isinstance(lab.get("name"), str):
            names.add(lab["name"])
        elif isinstance(lab, str):
            names.add(lab)
    return frozenset(names)


def _repo_full_name(payload: Dict[str, Any]) -> str:
    repo = payload.get("repository")
    if isinstance(repo, dict):
        return str(repo.get("full_name") or "")
    return ""


# --------------------------------------------------------------------------- #
# Signature verification (AC3)
# --------------------------------------------------------------------------- #
def verify_signature(
    raw_body: bytes, signature_header: Optional[str], secret: Optional[str]
) -> bool:
    """Verify the ``X-Hub-Signature-256`` HMAC over the raw request body.

    If ``secret`` is falsy, verification is **skipped** and the delivery is
    accepted — convenient for ``gh webhook forward`` without a secret, but
    insecure (anyone who can reach the port can trigger the loop). Set
    ``GITHUB_WEBHOOK_SECRET`` (and ``--secret`` on ``gh webhook forward``) to
    require a valid signature.

    With a secret set, the header must be present and equal (constant-time) to
    ``sha256=<hmac-sha256(secret, raw_body)>``; a missing or mismatched
    signature returns ``False`` (the server then answers 401).
    """
    if not secret:
        return True
    if not signature_header:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


# --------------------------------------------------------------------------- #
# The HTTP wrapper (POST /webhook) — wired by the CLI with real adapters
# --------------------------------------------------------------------------- #
class WebhookServer:
    """A stdlib ``http.server`` receiver routing ``POST /webhook`` to the handler.

    Owns no policy of its own: it decodes/authenticates the HTTP request and
    delegates the admit→enqueue→dispatch decision to :func:`handle_event` with
    the injected adapters. Constructed by ``agentrail heartbeat serve`` with the
    real PostgresExecutor-backed store, the connector config, and the escalation
    runtime; tests exercise :func:`handle_event` directly with fakes.

    Only the GitHub ``issues`` event is dispatched (``X-GitHub-Event``); other
    events (and GitHub's ``ping``) are acked 200 and ignored.
    """

    def __init__(
        self,
        *,
        workspace_id: str,
        store: _Store,
        runtime: _Runtime,
        connector_config: _ConnectorConfig,
        port: int = 8787,
        host: str = "127.0.0.1",
        secret: Optional[str] = None,
        ingest: Ingest = _default_ingest,
        on_result: Optional[Callable[[EventResult], None]] = None,
    ) -> None:
        self.workspace_id = workspace_id
        self.store = store
        self.runtime = runtime
        self.connector_config = connector_config
        self.port = port
        self.host = host
        # Default the secret from the environment so the CLI need not pass it.
        self.secret = secret if secret is not None else os.environ.get(
            WEBHOOK_SECRET_ENV
        )
        self.ingest = ingest
        self.on_result = on_result
        self._httpd: Optional[ThreadingHTTPServer] = None

    def serve_forever(self) -> None:  # pragma: no cover - blocking I/O loop
        """Bind the port and serve until interrupted (Ctrl-C exits clean)."""
        self._httpd = ThreadingHTTPServer(
            (self.host, self.port), self._make_handler()
        )
        try:
            self._httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            self._httpd.server_close()

    def _make_handler(self):
        server = self

        class _Handler(BaseHTTPRequestHandler):
            # Quiet the default stderr access log; the CLI prints its own lines.
            def log_message(self, *args):  # noqa: D401
                return

            def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler API)
                if self.path.rstrip("/") not in ("/webhook", ""):
                    self._send(404, {"error": "not found"})
                    return
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""

                # AC3: reject a bad/missing signature when a secret is configured.
                sig = self.headers.get(SIGNATURE_HEADER)
                if not verify_signature(raw, sig, server.secret):
                    self._send(401, {"error": "invalid signature"})
                    return

                event = self.headers.get("X-GitHub-Event", "")
                if event != "issues":
                    # ping / non-issue events: ack and ignore.
                    self._send(200, {"ignored": event or "unknown"})
                    return

                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    self._send(400, {"error": "invalid json"})
                    return

                result = handle_event(
                    payload,
                    workspace_id=server.workspace_id,
                    store=server.store,
                    runtime=server.runtime,
                    connector_config=server.connector_config,
                    ingest=server.ingest,
                )
                if server.on_result is not None:
                    server.on_result(result)
                self._send(
                    200,
                    {
                        "matched": result.matched,
                        "enqueued": result.enqueued,
                        "dispatched": result.dispatched,
                    },
                )

            def _send(self, code: int, body: dict) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return _Handler
