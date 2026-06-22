#!/usr/bin/env bash
# Objective-gate verify for AgentRail's own repo (issue #907, sub-issue of #891).
#
# Thin wrapper over agentrail.run.verify_gate — the SINGLE SOURCE OF TRUTH for
# change-set classification, shared with the pipeline's Red-Green Proof decision
# so the standalone check and the gate can never drift (AC3).
#
# The module classifies the change set (committed-on-branch ∪ uncommitted
# working-tree) and:
#   - runs the changed test files with pytest (the Red-Green Proof), or
#   - greens a docs/config-only change (legitimately test-free), or
#   - reds a Python-source change that added no test (anti-false-green, ADR 0008), or
#   - reds a no-op run (nothing produced).
#
# Run from the repo root (cwd), where the `agentrail` package is importable.
exec python3 -m agentrail.run.verify_gate
