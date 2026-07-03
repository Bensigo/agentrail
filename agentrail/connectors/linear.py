"""Linear connector — the Linear adapter behind ``connectors/base.py`` (M038).

A **Connector** (CONTEXT.md, ADR 0010) is the two-way seam between an external
tool and the **Issue Queue**: it ingests human-created issues into the queue and
reports results back. This module is the Linear adapter; it mirrors the GitHub
adapter (``agentrail/connectors/github.py``) — ``ingest`` lists labeled issues and
feeds each through the **input-contract gate**
(``afk/input_contract.admit_to_queue``) so only issues with machine-checkable
acceptance criteria enter the queue; ``post_result`` posts the run's terminal
outcome back on the issue; ``notify`` is a safe no-op (Linear's channel is the
issue comment itself; Discord owns channel notifications).

Linear's API is **GraphQL** (https://api.linear.app/graphql). Unlike GitHub there
is no ``gh``-style CLI, so the single I/O seam is a ``transport`` callable
``(query, variables) -> parsed_json``. The default transport posts to Linear over
stdlib :mod:`urllib` (no SDK, matching the no-new-deps constraint); tests inject a
fake transport so the adapter is exercised against a mocked API with no network.
"""
from __future__ import annotations

import json
import urllib.request
from typing import Callable, List, Optional

from agentrail.afk.input_contract import Rejected, admit_to_queue
from agentrail.connectors.base import (
    Connector,
    ConnectorEvent,
    IngestedIssue,
    IssueRef,
    OutcomeReport,
)

LINEAR_API_URL = "https://api.linear.app/graphql"

# A transport runs one GraphQL operation and returns the parsed JSON response.
Transport = Callable[[str, dict], dict]

# Pull issues carrying the ingest label. We fetch the fields the gate + the
# IngestedIssue need: stable id (for post_result), human number/title, the
# description (issue body, run through the input-contract gate), and the URL.
_ISSUES_QUERY = """
query IngestIssues($label: String!) {
  issues(filter: { labels: { name: { eq: $label } } }) {
    nodes {
      id
      number
      title
      description
      url
    }
  }
}
""".strip()

# Post the run outcome back as a comment on the source issue (the *back* channel).
_COMMENT_MUTATION = """
mutation PostResult($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
  }
}
""".strip()


def _default_transport(api_key: str) -> Transport:
    """Build the live transport: POST GraphQL to Linear over stdlib urllib.

    No SDK and no third-party HTTP client — mirrors the GitHub adapter's reliance
    on the stdlib. Authorization is Linear's personal/OAuth API key header.
    """

    def _transport(query: str, variables: dict) -> dict:
        data = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        req = urllib.request.Request(
            LINEAR_API_URL,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": api_key,
            },
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:  # noqa: S310 (fixed Linear URL)
            return json.loads(resp.read().decode("utf-8"))

    return _transport


class LinearConnector(Connector):
    """Linear adapter for the two-way connector contract (AC1/AC2).

    Thin orchestration: it does the GraphQL I/O (through the injectable
    ``transport``) and the pure ``afk/input_contract`` gate for admission. It owns
    no decision logic of its own — listing and posting are side effects; admission
    is the gate's call, exactly like :class:`~agentrail.connectors.github.GitHubConnector`.
    """

    def __init__(
        self,
        *,
        api_key: str = "",
        ingest_label: str = "ready-for-agent",
        transport: Optional[Transport] = None,
    ) -> None:
        self.api_key = api_key
        # Default to the same ready label the AFK CLI / GitHub adapter uses.
        self.ingest_label = ingest_label
        self._transport: Transport = transport or _default_transport(api_key)

    def ingest(self) -> List[IngestedIssue]:
        """List Linear issues carrying the ingest label and run each through the gate.

        Runs the GraphQL ``issues`` query (filtered by label), then hands every
        issue's description through ``input_contract.admit_to_queue`` — the single
        seam that mints a ``QueueEntry`` only when the issue carries
        machine-checkable acceptance criteria. Issues without AC come back
        ``admitted=False`` with the reason so the caller can audit why they were
        kept out. The Linear stable ``id`` is preserved as the URL-adjacent ref so
        ``post_result`` can address the comment mutation.
        """
        payload = self._transport(_ISSUES_QUERY, {"label": self.ingest_label})
        nodes = (
            (payload or {}).get("data", {}).get("issues", {}).get("nodes", []) or []
        )
        results: List[IngestedIssue] = []
        for node in nodes:
            number = int(node.get("number", 0))
            body = node.get("description") or ""
            admission = admit_to_queue(number=number, issue_body=body)
            if isinstance(admission, Rejected):
                results.append(
                    IngestedIssue(
                        number=number,
                        title=node.get("title", ""),
                        admitted=False,
                        reason=admission.missing_ac,
                        url=node.get("url", ""),
                    )
                )
            else:
                results.append(
                    IngestedIssue(
                        number=number,
                        title=node.get("title", ""),
                        admitted=True,
                        entry=admission,
                        url=node.get("url", ""),
                    )
                )
        return results

    def post_result(self, issue_ref, outcome: OutcomeReport) -> None:
        """Post the run's terminal outcome back as a comment on the issue.

        ``issue_ref`` is the Linear issue's stable ``id`` (Linear's comment
        mutation addresses issues by id, not by the human number).
        """
        self._transport(
            _COMMENT_MUTATION,
            {"issueId": issue_ref, "body": outcome.to_comment()},
        )

    def notify(self, event: ConnectorEvent) -> None:
        """No-op for Linear: the back channel is the issue comment itself.

        Channel notifications (Slack/Discord) are a separate adapter's job; Linear
        surfaces the result via ``post_result``. Kept as an explicit no-op so the
        interface contract holds without a misleading second comment.
        """
        return None


# --------------------------------------------------------------------------- #
# Heartbeat poll client (issue #1036): the runtime-Protocol Linear intake
# --------------------------------------------------------------------------- #
class LinearPollClient:
    """Poll-and-post Linear intake for the **live heartbeat loop** (issue #1036).

    The live dispatcher (``agentrail/heartbeat/runtime.py``) drives intake through
    a different, minimal Protocol than the two-way ``connectors/base.Connector``:
    ``poll(workspace_id) -> List[IssueRef]`` plus ``post_result(IssueRef, ...)``.
    :class:`~agentrail.connectors.github.GitHubOAuthClient` is that Protocol for
    GitHub; this is the exact-symmetric Linear client.

    Crucially, admission is **not** done here. The runtime feeds every polled
    ``IssueRef.body`` through ``QueueStore.enqueue`` — the single Input-Contract v2
    gate both GitHub and Linear share (issue #1026) — so there is no second gate
    and no bypass. This client only does the GraphQL I/O (list + comment-back)
    through the injectable ``transport``; tests replay canned GraphQL payloads with
    no network, exactly like :class:`LinearConnector`.

    Linear addresses issues by an opaque stable ``id`` (not the human number), so
    ``poll`` stashes that ``id`` in :attr:`IssueRef.repo`. That serves double duty:
    it makes ``_external_id`` (``{id}#{number}``) a stable per-issue dedupe key AND
    gives ``post_result`` the exact ``id`` the comment mutation needs — no extra
    ``IssueRef`` field required. The human number/title/url ride along as usual.
    """

    #: The queue ``source`` string every entry this client feeds is stamped with,
    #: so ``QueueStore.enqueue`` persists ``source = "linear"`` (AC3) and the
    #: rate limiter keys it via ``_SOURCE_TO_WRITER["linear"]``.
    source = "linear"

    def __init__(
        self,
        *,
        api_key: str = "",
        trigger_label: str = "ready-for-agent",
        transport: Optional[Transport] = None,
    ) -> None:
        self.api_key = api_key
        # The label a Linear issue must carry to be picked up — symmetric with the
        # GitHub trigger label. Defaults to the same ready label the rest of the
        # loop uses so a workspace that sets nothing still works.
        self.trigger_label = trigger_label
        self._transport: Transport = transport or _default_transport(api_key)

    def poll(self, workspace_id: str) -> List[IssueRef]:
        """List trigger-labeled Linear issues as :class:`IssueRef`\\ s (no admission).

        Runs the same GraphQL ``issues`` query (filtered by the trigger label) that
        :meth:`LinearConnector.ingest` uses, but returns raw ``IssueRef``\\ s for the
        runtime to gate — admission happens once, at ``QueueStore.enqueue``, so
        Linear and GitHub share exactly one gate. ``workspace_id`` scopes which
        api-key/label the caller resolved; carried for symmetry with the GitHub
        client's workspace-scoped ``poll``.
        """
        payload = self._transport(_ISSUES_QUERY, {"label": self.trigger_label})
        nodes = (
            (payload or {}).get("data", {}).get("issues", {}).get("nodes", []) or []
        )
        refs: List[IssueRef] = []
        for node in nodes:
            refs.append(
                IssueRef(
                    # The Linear stable id rides in ``repo`` so it round-trips to
                    # post_result and makes ``{id}#{number}`` a stable dedupe key.
                    repo=str(node.get("id", "")),
                    number=int(node.get("number", 0)),
                    title=node.get("title") or "",
                    body=node.get("description") or "",
                    url=node.get("url") or "",
                )
            )
        return refs

    def post_result(self, issue_ref: IssueRef, result: OutcomeReport) -> None:
        """Comment the run's terminal outcome back on the source Linear issue.

        The runtime hands back the same :class:`IssueRef` ``poll`` returned, so the
        Linear stable ``id`` is in ``issue_ref.repo`` — exactly what the Linear
        comment mutation addresses by. Best-effort at the runtime boundary (a raise
        is caught and logged there), matching the GitHub client's back channel.
        """
        self._transport(
            _COMMENT_MUTATION,
            {"issueId": issue_ref.repo, "body": result.to_comment()},
        )
