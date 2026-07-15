"""Tests for the memory-lane on/off gate (branch feat/measure-memory-lane-tokens).

The factory memory lane (#1039) is ALWAYS on in production; this gate lets an
offline before/after token A/B turn it off (``full`` vs ``full-minus-memory_lane``)
without touching the producer. Two properties are load-bearing and tested here:

* The resolver ``memory_lane_enabled`` defaults ON and parses its env flag like
  the other default-ON context layers (only ``0``/``false``/``off``/``no``
  disables it — mirroring ``AGENTRAIL_CONTEXT_RERANK``).
* ``build_context_pack`` empties the memory lane when the gate is OFF and
  populates it when ON, given the same injected ``memory_items``. The
  ``memoryLane`` section itself is never removed — disabling only empties it.

Hermetic: reuses ``test_memory_lane``'s tiny local-git fixture (``_make_repo``)
and ingest-shaped rows (``_mem``); no live Postgres, network, or unmocked
subprocess.
"""
from __future__ import annotations

from agentrail.context.memory_lane import MEMORY_LANE_ENV, memory_lane_enabled
from agentrail.context.packs import build_context_pack, load_context_pack

# Reuse the same faithful fixture + ingest-shaped row builder the memory-lane
# tests use (the pattern test_memory_fetch.py already relies on).
from agentrail.tests.context.test_memory_lane import _make_repo, _mem


# ---------------------------------------------------------------------------
# Resolver: default ON; only the disable set turns it OFF.
# ---------------------------------------------------------------------------
def test_memory_lane_enabled_defaults_on_when_unset() -> None:
    # Injected empty env == var unset => ON (the production default).
    assert memory_lane_enabled(env={}) is True


def test_memory_lane_enabled_on_for_explicit_one() -> None:
    assert memory_lane_enabled(env={MEMORY_LANE_ENV: "1"}) is True


def test_memory_lane_enabled_off_for_zero() -> None:
    assert memory_lane_enabled(env={MEMORY_LANE_ENV: "0"}) is False


def test_memory_lane_enabled_disable_set_is_case_and_space_insensitive() -> None:
    # The full disable set, mirroring the AGENTRAIL_CONTEXT_RERANK idiom.
    for off in ("0", "false", "off", "no", " OFF ", "False", "No"):
        assert memory_lane_enabled(env={MEMORY_LANE_ENV: off}) is False
    # Anything else keeps it ON (an unrecognized value must NOT silently disable).
    for on in ("1", "true", "on", "yes", "", "maybe"):
        assert memory_lane_enabled(env={MEMORY_LANE_ENV: on}) is True


def test_memory_lane_enabled_reads_os_environ_by_default(monkeypatch) -> None:
    monkeypatch.delenv(MEMORY_LANE_ENV, raising=False)
    assert memory_lane_enabled() is True
    monkeypatch.setenv(MEMORY_LANE_ENV, "0")
    assert memory_lane_enabled() is False
    monkeypatch.setenv(MEMORY_LANE_ENV, "1")
    assert memory_lane_enabled() is True


# ---------------------------------------------------------------------------
# Pack path: OFF empties the lane, ON populates it — same injected items.
# ---------------------------------------------------------------------------
_INGESTED = _mem(
    "id-decision-1",
    "We build Jace on the Eve framework.",
    mem_type="decision",
    written_by="jace",
    source="chat",
)


def _lane_for(root, items):
    result = build_context_pack(root, "issue", 1, "plan", memory_items=items)
    return load_context_pack(root, result["packId"])


def test_pack_memory_lane_is_empty_when_gate_off(monkeypatch) -> None:
    monkeypatch.setenv(MEMORY_LANE_ENV, "0")
    pack = _lane_for(_make_repo(), [_INGESTED])
    # The section still exists (not removed) — it is just emptied.
    assert "memoryLane" in pack
    assert pack["memoryLane"] == []


def test_pack_memory_lane_is_populated_when_gate_on(monkeypatch) -> None:
    monkeypatch.setenv(MEMORY_LANE_ENV, "1")
    pack = _lane_for(_make_repo(), [_INGESTED])
    lane = pack["memoryLane"]
    assert len(lane) == 1
    assert lane[0]["content"] == "We build Jace on the Eve framework."
    assert lane[0]["type"] == "decision"
    assert lane[0]["writtenBy"] == "jace"


def test_pack_memory_lane_defaults_populated_when_var_unset(monkeypatch) -> None:
    # Production default: unset var keeps the lane ON.
    monkeypatch.delenv(MEMORY_LANE_ENV, raising=False)
    pack = _lane_for(_make_repo(), [_INGESTED])
    assert len(pack["memoryLane"]) == 1
