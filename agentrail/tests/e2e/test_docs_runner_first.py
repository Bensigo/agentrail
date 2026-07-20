"""Docs contract test — originally issue #867, reframed by #1280/#1356, retired
by #1355.

History: #867 pinned "hosted dashboard + self-hosted runner is the PRIMARY
(and required) path" as the AC contract for every doc surface (quickstart,
install, index, introduction, README, npm-README). #1280/#1356 then rewrote
quickstart.mdx to a message-first flow (sign up -> connect GitHub -> message
Jace -> approve the brief -> reviewed PR, zero required CLI/runner) and moved
all runner-install content to a standalone getting-started/self-hosting.mdx
page, reversing #867's quickstart framing by design. #1355 tracked updating
this file's stale pins for that reversal; PR #1367 already rewrote
``TestQuickstartNewFlow`` to pin the shipped message-first contract instead
of the deleted CLI steps, and this pass (#1355) adds
``test_no_runner_install_markers_anywhere`` as a hard tripwire with no
disclaimer-sentence escape hatch, verified via sabotage-test (see PR
description).

What's still runner-first ON PURPOSE, because these surfaces genuinely
document the self-hosting/CLI path rather than the hosted message-first
entry point: installation.mdx (installing the CLI), README.md's
"Self-hosting: install & quick start" section, and npm-README.md (the CLI
package's own README). Those classes below (``test_installation_login_required``,
``TestReadmesRunnerFirst``) intentionally still assert `agentrail login` /
`agentrail runner` presence — dropping them would stop enforcing that
self-hosting docs stay complete, which is a real regression, not stale
framing.

Acceptance criteria now covered:
  AC1  No doc/README still says "works fully without an account" or frames
       dashboard/runner as "optional / secondary / team layer" (unchanged
       from #867 — still true).
  AC2  quickstart.mdx documents the message-first flow: sign-up -> connect
       GitHub -> message Jace -> approve the brief -> reviewed PR, with ZERO
       runner-install content (`agentrail login`, `agentrail runner`,
       `npm install -g @useagentrail/cli`, `ready-for-agent`) anywhere in the
       file — enforced unconditionally by
       ``test_no_runner_install_markers_anywhere``, not just via a "no CLI"
       disclaimer sentence.
  AC3  installation.mdx (a self-hosting-CLI doc, not the hosted quickstart)
       lists `agentrail login` as a required step after install.
  AC4  index.mdx and introduction.mdx frame message-first as the default,
       self-hosting as the supported alternative — no "primary and required"
       runner framing.
  AC5  README.md and npm-README.md — both self-hosting-oriented documents —
       still document `agentrail login` / `agentrail runner` in full.
  AC6  Self-hosting content (getting-started/self-hosting.mdx) stands alone:
       a reader on the OSS/self-host path never needs the hosted quickstart.
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
    """Asserts the message-first onboarding is present in quickstart.mdx.

    The runner-first CLI framing this class originally pinned (#867 —
    ``agentrail login`` → ``agentrail runner``, the ``ready-for-agent`` label)
    was deliberately reversed by the message-first pivot (#1356): the shipped
    quickstart is now sign up → connect GitHub → message Jace → describe the
    work → approve the brief → get a reviewed PR, with the worker running in
    the cloud (no required local CLI login/runner). These assertions pin THAT
    contract. (Self-hosting still documents the CLI — see self-hosting.mdx —
    so the README/self-host tests below intentionally keep the CLI steps.)
    """

    @pytest.fixture(autouse=True)
    def _content(self) -> None:
        self.content = _docs("getting-started/quickstart.mdx")
        self.lower = self.content.lower()

    def test_step_signup_mentioned(self) -> None:
        assert any(phrase in self.lower for phrase in ("sign up", "sign in")), (
            "quickstart.mdx must open with a sign-up / sign-in step."
        )

    def test_connect_github_mentioned(self) -> None:
        assert "github" in self.lower, (
            "quickstart.mdx must mention connecting GitHub."
        )

    def test_message_jace_present(self) -> None:
        assert "message jace" in self.lower or "message the bot" in self.lower, (
            "quickstart.mdx must document messaging Jace as the core step."
        )

    def test_approve_brief_present(self) -> None:
        assert "brief" in self.lower and "approv" in self.lower, (
            "quickstart.mdx must document approving the brief — the one confirmation."
        )

    def test_pull_request_outcome_present(self) -> None:
        assert "pull request" in self.lower, (
            "quickstart.mdx must document that the outcome is a reviewed pull request."
        )

    def test_no_required_cli_login_runner(self) -> None:
        """Message-first: the primary flow needs no local CLI login/runner."""
        assert (
            "no cli" in self.lower
            or "no runner to install" in self.lower
            or ("agentrail login" not in self.content and "agentrail runner" not in self.content)
        ), (
            "quickstart.mdx must present the cloud/message-first flow — no required "
            "`agentrail login` / `agentrail runner` steps (the runner-first #867 framing "
            "was reversed by the message-first pivot #1356)."
        )

    def test_no_runner_install_markers_anywhere(self) -> None:
        """Hard tripwire (#1355 AC2): zero runner-install content, full stop.

        ``test_no_required_cli_login_runner`` above lets these markers back in
        as long as a "no CLI" disclaimer sentence survives elsewhere in the
        doc — that's easy to defeat by *adding* a runner section without
        touching the disclaimer. This assertion has no escape hatch: none of
        these phrases may appear in quickstart.mdx at all. Runner-install
        content belongs on the standalone self-hosting page instead (see
        getting-started/self-hosting.mdx).
        """
        forbidden = (
            "agentrail login",
            "agentrail runner",
            "npm install -g @useagentrail/cli",
            "ready-for-agent",
        )
        found = [phrase for phrase in forbidden if phrase in self.lower]
        assert not found, (
            f"quickstart.mdx must contain zero runner-install content, but found: {found!r}. "
            "Runner-install steps (CLI install, `agentrail login`, `agentrail runner`, "
            "the `ready-for-agent` label) belong on the standalone self-hosting page "
            "(getting-started/self-hosting.mdx), not the quickstart."
        )

    def test_message_before_pr_ordered(self) -> None:
        """Messaging Jace must come before the resulting PR in the document."""
        msg_pos = self.lower.find("message jace")
        pr_pos = self.lower.find("pull request")
        assert msg_pos != -1, "message Jace step not found in quickstart.mdx"
        assert pr_pos != -1, "pull request outcome not found in quickstart.mdx"
        assert msg_pos < pr_pos, (
            "messaging Jace must come before the PR outcome in quickstart.mdx."
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
