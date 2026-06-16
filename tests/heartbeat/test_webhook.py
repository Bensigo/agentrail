"""GitHub issue webhook receiver — hermetic tests for handle_event + signature.

Every edge (store, runtime, connector config, ingest gate) is injected as a fake,
so the admit→enqueue→dispatch decision is fully reproducible with no network, no
Docker, no DB. Covers:

- AC1: an issues/labeled event whose label matches the connector trigger label
  enqueues the issue (correct IssueRef / external_id) and dispatches.
- AC2: a non-matching label or irrelevant action is ignored (no enqueue, no
  dispatch).
- AC3: HMAC signature verification — bad/missing rejected, valid passes.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import List, Optional

from agentrail.afk.input_contract import Rejected
from agentrail.connectors.base import IssueRef
from agentrail.heartbeat.webhook import (
    EventResult,
    handle_event,
    verify_signature,
)

TRIGGER = "ready-for-agent"
_VALID_BODY = "## Acceptance criteria\n- [ ] AC1: it works\n"


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
@dataclass
class _Cfg:
    trigger_label: str = TRIGGER


@dataclass
class _Admitted:
    number: int


class FakeStore:
    def __init__(self, *, reject: bool = False):
        self.enqueued: List[dict] = []
        self._reject = reject
        self._n = 0

    def enqueue(self, *, workspace_id, source, external_id, title, body,
                blocked_by=frozenset()):
        if self._reject:
            return Rejected(missing_ac="deduped")
        self.enqueued.append(
            {
                "workspace_id": workspace_id,
                "source": source,
                "external_id": external_id,
                "title": title,
                "body": body,
            }
        )
        self._n += 1
        return _Admitted(number=self._n)


@dataclass
class _DispatchReport:
    dispatched: int = 0


class FakeRuntime:
    def __init__(self, dispatched: int = 1):
        self.calls: List[tuple] = []
        self._dispatched = dispatched

    def dispatch_pending(self, workspace_id, refs_by_number=None):
        self.calls.append((workspace_id, refs_by_number))
        return _DispatchReport(dispatched=self._dispatched)


def _payload(action="labeled", *, labels=(TRIGGER,), repo="acme/widgets",
             number=7, body=_VALID_BODY, with_issue=True):
    pl = {"action": action, "repository": {"full_name": repo}}
    if with_issue:
        pl["issue"] = {
            "number": number,
            "title": "Add widget",
            "body": body,
            "html_url": f"https://github.com/{repo}/issues/{number}",
            "labels": [{"name": n} for n in labels],
        }
    return pl


def _handle(payload, store=None, runtime=None, cfg=None, **kw):
    return handle_event(
        payload,
        workspace_id="ws-1",
        store=store or FakeStore(),
        runtime=runtime or FakeRuntime(),
        connector_config=cfg or _Cfg(),
        **kw,
    )


# --------------------------------------------------------------------------- #
# AC1 — matching label enqueues + dispatches
# --------------------------------------------------------------------------- #
def test_ac1_labeled_matching_trigger_enqueues_and_dispatches():
    store = FakeStore()
    runtime = FakeRuntime(dispatched=1)
    result = _handle(_payload("labeled"), store=store, runtime=runtime)

    assert result.matched is True
    assert result.enqueued == 1
    assert result.dispatched == 1
    # correct external_id (repo#number) and IssueRef-derived fields enqueued.
    assert store.enqueued[0]["external_id"] == "acme/widgets#7"
    assert store.enqueued[0]["source"] == "github"
    assert store.enqueued[0]["title"] == "Add widget"
    # dispatch called once with the issue ref keyed by minted entry number.
    assert len(runtime.calls) == 1
    ws, refs = runtime.calls[0]
    assert ws == "ws-1"
    assert isinstance(refs[1], IssueRef)
    assert refs[1].repo == "acme/widgets" and refs[1].number == 7


def test_ac1_opened_and_reopened_are_trigger_actions():
    for action in ("opened", "reopened"):
        store = FakeStore()
        runtime = FakeRuntime()
        result = _handle(_payload(action), store=store, runtime=runtime)
        assert result.enqueued == 1, action
        assert len(runtime.calls) == 1, action


# --------------------------------------------------------------------------- #
# AC2 — non-matching label / irrelevant action ignored (no enqueue, no dispatch)
# --------------------------------------------------------------------------- #
def test_ac2_non_matching_label_is_ignored():
    store = FakeStore()
    runtime = FakeRuntime()
    result = _handle(_payload("labeled", labels=("bug",)), store=store, runtime=runtime)

    assert result.matched is False
    assert result.enqueued == 0
    assert store.enqueued == []
    assert runtime.calls == []


def test_ac2_irrelevant_action_is_ignored():
    store = FakeStore()
    runtime = FakeRuntime()
    # 'closed' is not a trigger action even with the trigger label present.
    result = _handle(_payload("closed"), store=store, runtime=runtime)

    assert result.matched is False
    assert store.enqueued == []
    assert runtime.calls == []


def test_ac2_no_issue_object_is_ignored():
    result = _handle(_payload("labeled", with_issue=False))
    assert result.matched is False


def test_rejected_by_ingest_gate_does_not_enqueue():
    # An issue without machine-checkable AC is matched but rejected: no enqueue,
    # no dispatch (the same input-contract gate the polling intake uses).
    store = FakeStore()
    runtime = FakeRuntime()
    result = _handle(
        _payload("labeled", body="just prose, no checkboxes"),
        store=store,
        runtime=runtime,
    )
    assert result.matched is True
    assert result.enqueued == 0
    assert store.enqueued == []
    assert runtime.calls == []


def test_store_dedupe_still_drains_queue():
    # A duplicate delivery (store returns Rejected) enqueues nothing new but still
    # drains the queue so prior stuck work makes progress.
    store = FakeStore(reject=True)
    runtime = FakeRuntime(dispatched=2)
    result = _handle(_payload("labeled"), store=store, runtime=runtime)
    assert result.enqueued == 0
    assert result.dispatched == 2
    assert len(runtime.calls) == 1


def test_string_labels_shape_is_supported():
    # GitHub sends label objects, but tolerate a plain-string label array too.
    payload = _payload("labeled")
    payload["issue"]["labels"] = [TRIGGER]
    result = _handle(payload)
    assert result.enqueued == 1


# --------------------------------------------------------------------------- #
# AC3 — HMAC-SHA256 signature verification
# --------------------------------------------------------------------------- #
def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_ac3_valid_signature_passes():
    body = json.dumps(_payload()).encode()
    assert verify_signature(body, _sign("s3cr3t", body), "s3cr3t") is True


def test_ac3_bad_signature_rejected():
    body = json.dumps(_payload()).encode()
    assert verify_signature(body, _sign("wrong", body), "s3cr3t") is False


def test_ac3_missing_signature_rejected_when_secret_set():
    body = b"{}"
    assert verify_signature(body, None, "s3cr3t") is False


def test_ac3_no_secret_accepts_anything():
    # Unset secret → verification skipped (insecure, but works for gh forward).
    assert verify_signature(b"{}", None, None) is True
    assert verify_signature(b"{}", "sha256=whatever", "") is True
