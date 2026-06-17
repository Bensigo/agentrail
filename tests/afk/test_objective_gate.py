from agentrail.afk import objective_gate as og


def test_ci_all_pass_returns_none_signal():
    checks = [{"name": "test", "state": "pass"}, {"name": "lint", "state": "pass"}]
    assert og.evaluate_ci(checks) is None


def test_ci_failure_blocks_with_reason():
    checks = [{"name": "test", "state": "fail"}, {"name": "lint", "state": "pass"}]
    res = og.evaluate_ci(checks)
    assert res is not None and res.state == "fail"
    assert any("test" in r for r in res.reasons)


def test_ci_pending_holds():
    checks = [{"name": "test", "state": "pending"}]
    res = og.evaluate_ci(checks)
    assert res is not None and res.state == "pending"


def test_ci_zero_checks_fails_not_silent_pass():
    res = og.evaluate_ci([])
    assert res is not None and res.state == "fail"
    assert any("no ci checks" in r.lower() for r in res.reasons)


def test_secret_scan_flags_private_key_and_token():
    added = ["-----BEGIN RSA PRIVATE KEY-----", "api_key = 'AKIAIOSFODNN7EXAMPLE'"]
    reasons = og.scan_secrets(added)
    assert len(reasons) == 2


def test_secret_scan_ignores_clean_lines():
    assert og.scan_secrets(["const x = 1", "# api_key documentation only"]) == []


def test_deleted_file_still_referenced_blocks():
    deleted = ["src/util/helper.py"]
    references = {"src/util/helper.py": ["src/app.py"]}
    reasons = og.deleted_files_in_use(deleted, references)
    assert len(reasons) == 1 and "helper.py" in reasons[0]


def test_deleted_file_unreferenced_ok():
    assert og.deleted_files_in_use(["src/util/helper.py"], {"src/util/helper.py": []}) == []


def test_evaluate_pass_when_ci_clean_and_no_security_issues():
    res = og.evaluate(
        checks=[{"name": "test", "state": "pass"}],
        added_lines=["const x = 1"],
        deleted_files=[],
        references={},
    )
    assert res.state == "pass" and res.reasons == []


def test_evaluate_ci_failure_short_circuits():
    res = og.evaluate(
        checks=[{"name": "test", "state": "fail"}],
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
        deleted_files=[],
        references={},
    )
    assert res.state == "fail"


def test_evaluate_security_blocks_even_when_ci_passes():
    res = og.evaluate(
        checks=[{"name": "test", "state": "pass"}],
        added_lines=["-----BEGIN RSA PRIVATE KEY-----"],
        deleted_files=[],
        references={},
    )
    assert res.state == "fail" and any("secret" in r.lower() or "key" in r.lower() for r in res.reasons)
