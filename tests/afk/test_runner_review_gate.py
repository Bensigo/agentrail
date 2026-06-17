import asyncio
import pytest
from agentrail.afk.objective_gate import ObjectiveGateResult


# Re-implements the loop decision logic to lock the contract. The runner's
# _review_and_gate must follow this exact control flow.
async def _drive_loop(gate, fix, merge, escalate, max_fix=2):
    attempts = 0
    while True:
        result = await gate(0)
        if result.passed:
            await merge(0)
            return
        if attempts >= max_fix:
            escalate()
            return
        attempts += 1
        ok = await fix(0, 0, 0, result)
        if not ok:
            escalate()
            return


def test_bounded_fix_escalates_after_two_attempts():
    attempts = {"gate": 0, "fix": 0, "merge": 0, "human": 0}

    async def gate(_pr):
        attempts["gate"] += 1
        return ObjectiveGateResult("fail", ["CI check 'test' failed"])

    async def fix(_slot, _issue, _pr, _gate):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    def escalate():
        attempts["human"] += 1

    asyncio.run(_drive_loop(gate, fix, merge, escalate))
    assert attempts["merge"] == 0
    assert attempts["human"] == 1
    assert attempts["fix"] == 2


def test_pass_path_merges():
    attempts = {"merge": 0, "human": 0, "fix": 0}

    async def gate(_pr):
        return ObjectiveGateResult("pass", [])

    async def fix(_s, _i, _p, _g):
        attempts["fix"] += 1
        return True

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    asyncio.run(_drive_loop(gate, fix, merge,
                            lambda: attempts.__setitem__("human", attempts["human"] + 1)))
    assert attempts["merge"] == 1 and attempts["human"] == 0 and attempts["fix"] == 0


def test_fix_failure_escalates_immediately():
    attempts = {"fix": 0, "merge": 0, "human": 0}

    async def gate(_pr):
        return ObjectiveGateResult("fail", ["CI check 'test' failed"])

    async def fix(_s, _i, _p, _g):
        attempts["fix"] += 1
        return False  # fix failed

    async def merge(_pr):
        attempts["merge"] += 1
        return True

    asyncio.run(_drive_loop(gate, fix, merge,
                            lambda: attempts.__setitem__("human", attempts["human"] + 1)))
    assert attempts["fix"] == 1 and attempts["merge"] == 0 and attempts["human"] == 1
