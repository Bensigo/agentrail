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
