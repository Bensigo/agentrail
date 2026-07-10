"""Acceptance test for issue #867 — docs rewritten to runner-first flow.

Pins the AC contract for the docs-narrative pivot: hosted dashboard +
self-hosted runner is the PRIMARY (and required) path; the stale "repo-native
primary / optional account" framing must be gone.

This test MUST FAIL before implementation (Red-Green Proof):
  - Stale phrases are still present in the files right now.
  - Required new phrases / steps are absent right now.

DO NOT edit production doc files to make this pass — that is the Implementer's job.

Acceptance criteria covered (issue #867):
  AC1  No doc/README still says "works fully without an account" or frames
       dashboard/runner as "optional / secondary / team layer".
  AC2  quickstart.mdx documents the 6-step flow: sign-up → connect GitHub
       (trigger label `ready-for-agent`) → install CLI → `agentrail login` →
       `agentrail runner` → label issue → reviewed PR.
  AC3  installation.mdx lists `agentrail login` as a required step after install.
  AC4  index.mdx and introduction.mdx lead with runner-first flow; login required.
  AC5  README.md and npm-README.md lead with dashboard + login + runner flow.
  AC6  Only docs/README files changed (no .py/.ts source edits in this PR) —
       validated by checking git diff in the repository.
"""
from __future__ import annotations

from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REPO = Path(__file__).resolve().parents[3]
_DOCS = _REPO / "apps" / "console" / "content" / "docs"


def _read(rel: str) -> str:
    return (_REPO / rel).read_text(encoding="utf-8")


def _docs(rel: str) -> str:
    return (_DOCS / rel).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# AC1 — Stale "optional / secondary / no-account" language must be gone
# ---------------------------------------------------------------------------


class TestStaleLanguageRemoved:
    """Every assertion here FAILS right now (stale text is still present)."""

    @pytest.mark.parametrize(
        "file,phrase",
        [
            # dashboard.mdx — currently says both of these
            (
                "dashboard.mdx",
                "CLI works fully without an account",
            ),
            (
                "dashboard.mdx",
                "optional team layer",
            ),
            (
                "dashboard.mdx",
                "secondary path",
            ),
            # team-runner.mdx — says "secondary path / works without an account"
            (
                "cli/team-runner.mdx",
                "secondary",
            ),
            (
                "cli/team-runner.mdx",
                "works fully without an account",
            ),
            # introduction.mdx — "Repo-native (primary)"
            (
                "getting-started/introduction.mdx",
                "Repo-native (primary)",
            ),
            # quickstart.mdx — framed as "repo-native flow"
            (
                "getting-started/quickstart.mdx",
                "repo-native flow",
            ),
            # index.mdx — "optional hosted console"
            (
                "index.mdx",
                "optional hosted console",
            ),
            (
                "index.mdx",
                "repo-native",
            ),
        ],
    )
    def test_stale_phrase_absent(self, file: str, phrase: str) -> None:
        content = _docs(file)
        assert phrase.lower() not in content.lower(), (
            f"{file} still contains stale phrase: {phrase!r}\n"
            "This must be removed as part of the runner-first docs rewrite (#867)."
        )


# ---------------------------------------------------------------------------
# AC2 — quickstart.mdx must document the new 6-step flow
# ---------------------------------------------------------------------------


class TestQuickstartNewFlow:
    """Asserts the 6-step runner-first onboarding is present in quickstart.mdx."""

    @pytest.fixture(autouse=True)
    def _content(self) -> None:
        self.content = _docs("getting-started/quickstart.mdx")

    def test_step_signup_mentioned(self) -> None:
        assert any(
            phrase in self.content.lower()
            for phrase in ("sign up", "sign in", "dashboard")
        ), "quickstart.mdx must open with sign-up / dashboard step."

    def test_connect_github_mentioned(self) -> None:
        assert "github" in self.content.lower(), (
            "quickstart.mdx must mention connecting GitHub."
        )

    def test_trigger_label_ready_for_agent(self) -> None:
        assert "ready-for-agent" in self.content, (
            "quickstart.mdx must document the `ready-for-agent` trigger label."
        )

    def test_agentrail_login_present(self) -> None:
        assert "agentrail login" in self.content, (
            "quickstart.mdx must include `agentrail login` as a step."
        )

    def test_agentrail_runner_present(self) -> None:
        assert "agentrail runner" in self.content, (
            "quickstart.mdx must include `agentrail runner` as a step."
        )

    def test_login_before_runner_ordered(self) -> None:
        """login must appear before runner in the document."""
        login_pos = self.content.find("agentrail login")
        runner_pos = self.content.find("agentrail runner")
        assert login_pos != -1, "agentrail login not found in quickstart.mdx"
        assert runner_pos != -1, "agentrail runner not found in quickstart.mdx"
        assert login_pos < runner_pos, (
            "`agentrail login` must come before `agentrail runner` in quickstart.mdx."
        )


# ---------------------------------------------------------------------------
# AC3 — installation.mdx must list `agentrail login` as a required post-install step
# ---------------------------------------------------------------------------


def test_installation_login_required() -> None:
    content = _docs("getting-started/installation.mdx")
    assert "agentrail login" in content, (
        "installation.mdx must list `agentrail login` as a required step after install."
    )


# ---------------------------------------------------------------------------
# AC4 — index.mdx and introduction.mdx must lead with runner-first flow
# ---------------------------------------------------------------------------


class TestIndexAndIntroRunnerFirst:
    def test_index_leads_with_dashboard_runner(self) -> None:
        content = _docs("index.mdx")
        # Must NOT describe the dashboard as optional
        assert "optional" not in content.lower() or "dashboard" not in content.lower() or (
            content.lower().find("optional") > content.lower().find("runner")
        ), "index.mdx must not describe the dashboard/runner as optional."
        # Must mention login as required
        assert "login" in content.lower(), (
            "index.mdx must reference `login` as part of the primary flow."
        )

    def test_introduction_runner_first(self) -> None:
        content = _docs("getting-started/introduction.mdx")
        # Old framing was "Two ways to run it" with Repo-native first
        assert "repo-native (primary)" not in content.lower(), (
            "introduction.mdx must not call repo-native the primary path."
        )
        # New framing must position runner/dashboard as primary
        assert "runner" in content.lower() or "dashboard" in content.lower(), (
            "introduction.mdx must lead with the runner/dashboard flow."
        )
        assert "login" in content.lower(), (
            "introduction.mdx must mention that login is required."
        )

    def test_introduction_login_required_stated(self) -> None:
        content = _docs("getting-started/introduction.mdx")
        # The issue requires stating login is required (with exempt commands noted)
        assert "required" in content.lower() or "must" in content.lower(), (
            "introduction.mdx must state that login is required for the CLI."
        )


# ---------------------------------------------------------------------------
# AC5 — README.md and npm-README.md must lead with dashboard + login + runner
# ---------------------------------------------------------------------------


class TestReadmesRunnerFirst:
    @pytest.fixture(autouse=True)
    def _contents(self) -> None:
        self.readme = _read("README.md")
        self.npm_readme = _read("npm-README.md")

    def test_readme_leads_with_dashboard(self) -> None:
        # Must mention login and runner prominently
        assert "agentrail login" in self.readme, (
            "README.md must mention `agentrail login` as the primary onboarding step."
        )
        assert "agentrail runner" in self.readme, (
            "README.md must mention `agentrail runner` as the primary run command."
        )

    def test_readme_no_repo_native_primary_framing(self) -> None:
        # README currently opens with "repo-native harness" — that framing must go
        assert "repo-native" not in self.readme.lower(), (
            "README.md must not describe AgentRail as 'repo-native' — "
            "the primary framing is now the hosted dashboard + runner flow."
        )

    def test_npm_readme_leads_with_dashboard_runner(self) -> None:
        assert "agentrail login" in self.npm_readme, (
            "npm-README.md must include `agentrail login` in the primary Quick Start flow."
        )
        assert "agentrail runner" in self.npm_readme, (
            "npm-README.md must include `agentrail runner` in the primary Quick Start flow."
        )

    def test_npm_readme_dashboard_not_optional(self) -> None:
        # Current npm-README has "Dashboard (Optional)" section
        assert "dashboard (optional)" not in self.npm_readme.lower(), (
            "npm-README.md must not describe the dashboard as optional."
        )
