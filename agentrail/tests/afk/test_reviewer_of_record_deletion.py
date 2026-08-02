"""Arc B §5 regression pin: the pipeline's model-review step stays deleted."""


def test_internal_cli_has_no_review_pr_command():
    from agentrail.cli.commands import internal
    assert not hasattr(internal, "_review_pr_native")


def test_runner_has_no_review_attributes():
    from agentrail.afk.runner import Runner
    assert not hasattr(Runner, "_review")
    assert not hasattr(Runner, "_review_and_gate")
    assert hasattr(Runner, "_gate_and_fix")


def test_runner_prior_deletions_stay_deleted():
    # Restores the tripwire lost with test_runner_review.py (unrelated,
    # earlier deletion): these worktree-era helpers must not resurface.
    from agentrail.afk.runner import Runner
    assert not hasattr(Runner, "_prepare_for_review")
    assert not hasattr(Runner, "_restore_main")


def test_review_modules_are_gone():
    import importlib.util
    for mod in ("agentrail.afk.review", "agentrail.afk.review_engine"):
        assert importlib.util.find_spec(mod) is None


def test_issue_status_has_no_reviewing():
    from agentrail.afk.state import IssueStatus
    assert not hasattr(IssueStatus, "REVIEWING")
