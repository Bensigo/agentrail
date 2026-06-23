"""Keep the frozen corpus answer keys out of normal pytest collection.

Files under ``evals/corpus/<task>/answer_key/`` are *hidden test suites* — the
ground-truth answer keys for corpus tasks. They are data, not part of this
repo's own test suite, and the eval harness mounts them only at scoring time.
Collecting them as ordinary tests would (a) run answer keys against the wrong
tree and (b) leak the answer key into a normal ``pytest`` run. Ignore them.

The corpus loader's *own* tests live under ``tests/evals/`` and are unaffected.
"""

from __future__ import annotations

collect_ignore_glob = ["corpus/*/answer_key/*"]
