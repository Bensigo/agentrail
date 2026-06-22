"""Escalation tier → model mapping for the self-hosted runner.

When a queued issue's run goes red/error, the backend re-admits it at a higher
``tier`` (see ``recordRunnerResult`` / ``nextQueueTransition`` in
``packages/db-postgres/src/queries/runner.ts``). The runner reads that tier off
the claimed ``WorkItem`` and uses this PURE, deterministic mapping to decide
which model to run the next attempt at — so an escalation actually *escalates*
instead of re-running at the same model that just failed (BUG 1).

Kept tiny and side-effect-free (apart from one env read) so it is trivially
unit-testable: tier 0 ⇒ no override (use the config default model); tier 1+ ⇒ a
strong model, overridable via ``AGENTRAIL_ESCALATION_MODEL``.
"""
from __future__ import annotations

import os
from typing import Optional

#: The env var that overrides the strong escalation model. Falls back to
#: DEFAULT_ESCALATION_MODEL when unset/blank.
ESCALATION_MODEL_ENV = "AGENTRAIL_ESCALATION_MODEL"

#: The default strong model used for any escalated (tier >= 1) attempt.
DEFAULT_ESCALATION_MODEL = "claude-opus-4-8"


def model_for_tier(tier: int, env: Optional[dict] = None) -> Optional[str]:
    """Map an escalation tier to a model override, or ``None`` for the default.

    - tier <= 0 → ``None``: pass no ``--model`` override; the local run uses the
      project's configured default model (tier 0 = the cheap/normal path).
    - tier >= 1 → the strong model: ``AGENTRAIL_ESCALATION_MODEL`` if set to a
      non-blank value, else :data:`DEFAULT_ESCALATION_MODEL`.

    ``env`` is injectable for hermetic tests; defaults to ``os.environ``.
    """
    if tier <= 0:
        return None
    source = os.environ if env is None else env
    override = source.get(ESCALATION_MODEL_ENV)
    if isinstance(override, str) and override.strip():
        return override.strip()
    return DEFAULT_ESCALATION_MODEL
