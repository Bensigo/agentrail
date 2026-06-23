"""Tests for the escalation tier → model mapping (agentrail/runner/escalation.py).

This is the pure half of BUG 1: a re-queued (previously red/error) attempt is
claimed at a higher tier, and the runner must run it at a STRONGER model rather
than the same one that just failed. tier 0 must stay on the config default.
"""
from __future__ import annotations

from agentrail.runner.escalation import (
    DEFAULT_ESCALATION_MODEL,
    ESCALATION_MODEL_ENV,
    model_for_tier,
)


def test_tier_zero_returns_none_so_config_default_is_used():
    assert model_for_tier(0) is None


def test_negative_tier_also_returns_none():
    assert model_for_tier(-1) is None


def test_tier_one_returns_strong_default_model():
    assert model_for_tier(1, env={}) == DEFAULT_ESCALATION_MODEL


def test_higher_tiers_also_return_the_strong_model():
    assert model_for_tier(2, env={}) == DEFAULT_ESCALATION_MODEL


def test_env_override_is_honored():
    env = {ESCALATION_MODEL_ENV: "claude-opus-4-8-custom"}
    assert model_for_tier(1, env=env) == "claude-opus-4-8-custom"


def test_blank_env_override_falls_back_to_default():
    assert model_for_tier(1, env={ESCALATION_MODEL_ENV: "   "}) == DEFAULT_ESCALATION_MODEL


def test_env_override_does_not_apply_to_tier_zero():
    # Even with an override set, tier 0 means "no override" (config default).
    assert model_for_tier(0, env={ESCALATION_MODEL_ENV: "x"}) is None
