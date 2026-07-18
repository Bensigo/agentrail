"""Hosted-repo quarantine lookup (#1271) — pure parsing + FakeExecutor tests.

No live DB: PostgresExecutor is never constructed here (resolve_foreign_
workspaces's own-executor path is exercised via dependency injection).
"""
from __future__ import annotations

import unittest
from typing import Any, Dict, List, Optional, Set

from agentrail.afk.hosted_repo_guard import (
    HOSTED_CONNECTORS_OP,
    HOSTED_REPOSITORIES_OP,
    find_hosted_workspaces,
    parse_repo_slug,
    resolve_foreign_workspaces,
)


class FakeExecutor:
    """In-memory Executor: canned rows per op, regardless of params.

    ``raise_ops`` lets a test simulate one (or both) of the two lookups
    throwing — e.g. a connection blip on just the ``repositories`` query —
    without touching the other, canned-rows op.
    """

    def __init__(
        self,
        rows_by_op: Dict[str, List[Dict[str, Any]]],
        *,
        raise_ops: Optional[Set[str]] = None,
    ):
        self._rows_by_op = rows_by_op
        self._raise_ops = raise_ops or set()
        self.queries: List[tuple] = []

    def execute(self, op: str, params: Dict[str, Any]) -> None:  # pragma: no cover
        raise AssertionError("hosted-repo guard seam only reads")

    def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.queries.append((op, params))
        if op in self._raise_ops:
            raise RuntimeError(f"{op} unavailable")
        return list(self._rows_by_op.get(op, []))


class ParseRepoSlugTests(unittest.TestCase):
    def test_https_form(self) -> None:
        self.assertEqual(parse_repo_slug("https://github.com/acme/widgets"), "acme/widgets")

    def test_https_form_with_dot_git(self) -> None:
        self.assertEqual(
            parse_repo_slug("https://github.com/acme/widgets.git"), "acme/widgets"
        )

    def test_https_form_with_trailing_slash(self) -> None:
        self.assertEqual(parse_repo_slug("https://github.com/acme/widgets/"), "acme/widgets")

    def test_ssh_form(self) -> None:
        self.assertEqual(
            parse_repo_slug("git@github.com:acme/widgets.git"), "acme/widgets"
        )

    def test_ssh_form_without_dot_git(self) -> None:
        self.assertEqual(parse_repo_slug("git@github.com:acme/widgets"), "acme/widgets")

    def test_normalizes_case(self) -> None:
        self.assertEqual(
            parse_repo_slug("https://github.com/Acme/Widgets.git"), "acme/widgets"
        )

    def test_non_github_host_is_none(self) -> None:
        self.assertIsNone(parse_repo_slug("https://gitlab.com/acme/widgets.git"))

    def test_empty_is_none(self) -> None:
        self.assertIsNone(parse_repo_slug(""))

    def test_garbage_is_none(self) -> None:
        self.assertIsNone(parse_repo_slug("not a url"))


class FindHostedWorkspacesTests(unittest.TestCase):
    def test_matches_via_connector_config_repos(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-1", "config": {"repos": ["acme/widgets"]}},
                    {"workspace_id": "ws-2", "config": {"repos": ["other/thing"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-1"])

    def test_matches_via_repositories_name_column(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [],
                HOSTED_REPOSITORIES_OP: [
                    {"workspace_id": "ws-3", "name": "acme/widgets", "url": ""},
                ],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-3"])

    def test_matches_via_repositories_url_column(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [],
                HOSTED_REPOSITORIES_OP: [
                    {
                        "workspace_id": "ws-4",
                        "name": "",
                        "url": "https://github.com/acme/widgets.git",
                    },
                ],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-4"])

    def test_matches_across_both_sources_deduplicated(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-1", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [
                    {"workspace_id": "ws-1", "name": "acme/widgets", "url": ""},
                    {"workspace_id": "ws-5", "name": "acme/widgets", "url": ""},
                ],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-1", "ws-5"])

    def test_case_insensitive_match(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-1", "config": {"repos": ["Acme/Widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-1"])

    def test_no_match_returns_empty(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-1", "config": {"repos": ["other/thing"]}},
                ],
                HOSTED_REPOSITORIES_OP: [
                    {"workspace_id": "ws-2", "name": "another/repo", "url": ""},
                ],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), [])

    def test_config_as_json_string_is_parsed(self) -> None:
        # jsonb may arrive as a string depending on the driver — same
        # defensive shape as connectors_store.
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-1", "config": '{"repos": ["acme/widgets"]}'},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), ["ws-1"])

    def test_missing_repos_key_does_not_crash(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [{"workspace_id": "ws-1", "config": {}}],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        self.assertEqual(find_hosted_workspaces("acme/widgets", ex), [])

    def test_query_ops_are_registered_in_postgres_sql(self) -> None:
        from agentrail.afk import hosted_repo_guard, queue_store

        assert HOSTED_CONNECTORS_OP in hosted_repo_guard.HOSTED_REPO_SQL
        assert HOSTED_REPOSITORIES_OP in hosted_repo_guard.HOSTED_REPO_SQL
        assert HOSTED_CONNECTORS_OP in queue_store._SQL
        assert HOSTED_REPOSITORIES_OP in queue_store._SQL


class ResolveForeignWorkspacesTests(unittest.TestCase):
    def test_excludes_own_workspace(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-own", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, [])
        self.assertIsNone(notice)

    def test_foreign_workspace_is_reported(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-customer", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, ["ws-customer"])
        self.assertIsNone(notice)

    def test_no_own_workspace_id_set_still_reports_any_match_as_foreign(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-customer", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            }
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id=None, executor=ex
        )
        self.assertEqual(foreign, ["ws-customer"])
        self.assertIsNone(notice)

    def test_executor_raising_degrades_to_notice_not_exception(self) -> None:
        class BoomExecutor:
            def query(self, op: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
                raise RuntimeError("connection refused")

        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=BoomExecutor()
        )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check skipped: no database reachable"
        )

    def test_default_executor_construction_failure_degrades(self) -> None:
        # No executor injected: resolve_foreign_workspaces must construct its
        # own PostgresExecutor and degrade on ANY failure (no DATABASE_URL, no
        # driver, unreachable host, ...) rather than raising. We don't need a
        # real DB for this — patch PostgresExecutor to blow up on construction.
        from unittest.mock import patch

        with patch(
            "agentrail.afk.queue_store.PostgresExecutor",
            side_effect=RuntimeError("no driver"),
        ):
            foreign, notice = resolve_foreign_workspaces(
                "acme/widgets", own_workspace_id="ws-own", executor=None
            )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check skipped: no database reachable"
        )


class PerQueryDegradeTests(unittest.TestCase):
    """resolve_foreign_workspaces must degrade the connectors query and the
    repositories query independently (#1271 review fix): a hit the surviving
    query already found must never be thrown away just because the OTHER,
    unrelated query happened to throw.
    """

    # -- (a)/(b): one source hits, the other throws -> the hit still refuses #

    def test_connectors_hit_survives_repositories_throwing(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-customer", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            },
            raise_ops={HOSTED_REPOSITORIES_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, ["ws-customer"])
        self.assertIsNone(notice)

    def test_repositories_hit_survives_connectors_throwing(self) -> None:
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [],
                HOSTED_REPOSITORIES_OP: [
                    {"workspace_id": "ws-customer", "name": "acme/widgets", "url": ""},
                ],
            },
            raise_ops={HOSTED_CONNECTORS_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, ["ws-customer"])
        self.assertIsNone(notice)

    # -- (c): both sources throw -> fail-open, not partial ------------------ #

    def test_both_sources_throwing_is_fail_open_not_partial(self) -> None:
        ex = FakeExecutor(
            {HOSTED_CONNECTORS_OP: [], HOSTED_REPOSITORIES_OP: []},
            raise_ops={HOSTED_CONNECTORS_OP, HOSTED_REPOSITORIES_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check skipped: no database reachable"
        )

    # -- (d): one source throws, no hit in the survivor -> partial notice --- #

    def test_connectors_throwing_with_no_hit_elsewhere_is_partial_notice(self) -> None:
        ex = FakeExecutor(
            {HOSTED_CONNECTORS_OP: [], HOSTED_REPOSITORIES_OP: []},
            raise_ops={HOSTED_CONNECTORS_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check partial: connectors unavailable"
        )

    def test_repositories_throwing_with_no_hit_elsewhere_is_partial_notice(self) -> None:
        ex = FakeExecutor(
            {HOSTED_CONNECTORS_OP: [], HOSTED_REPOSITORIES_OP: []},
            raise_ops={HOSTED_REPOSITORIES_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check partial: repositories unavailable"
        )

    def test_hit_belonging_only_to_own_workspace_with_other_source_throwing_is_partial(
        self,
    ) -> None:
        # The surviving query DID find a hit, but it's the operator's own
        # workspace (excluded from `foreign`) — this must still report the
        # reduced coverage, not a clean, silent proceed: the failed source
        # might have found a genuinely foreign match.
        ex = FakeExecutor(
            {
                HOSTED_CONNECTORS_OP: [
                    {"workspace_id": "ws-own", "config": {"repos": ["acme/widgets"]}},
                ],
                HOSTED_REPOSITORIES_OP: [],
            },
            raise_ops={HOSTED_REPOSITORIES_OP},
        )
        foreign, notice = resolve_foreign_workspaces(
            "acme/widgets", own_workspace_id="ws-own", executor=ex
        )
        self.assertEqual(foreign, [])
        self.assertEqual(
            notice, "hosted-repo quarantine check partial: repositories unavailable"
        )


if __name__ == "__main__":
    unittest.main()
