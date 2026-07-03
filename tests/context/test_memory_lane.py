"""Tests for the factory-side memory lane (issue #1039).

One test per acceptance criterion:

- AC1: a memory written through the ingest route appears — typed and attributed —
  in a subsequently built pack's memory lane.
- AC2: the size cap is enforced with deterministic selection/truncation; the same
  inputs produce a byte-identical lane across two builds.
- AC3: the lane is delimited/framed as untrusted advisory content in the assembled
  prompt (snapshot of the framing).
- AC4: a secret-bearing memory item can never appear in a lane; the read-side
  filter is exercised directly.

All tests are hermetic: no live Postgres, no network, no unmocked subprocess that
can hang. AC1 builds a real pack on a tiny local git fixture (the same
``_make_repo`` shape ``test_packs.py`` uses) and INJECTS the memory rows, so the
"store" is a faithful, ingest-shaped in-memory fake — typed (``type``) and
attributed (``written_by``), matching the memory_items v2 schema (#1032).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agentrail.context.index import build_index
from agentrail.context.memory_lane import (
    MEMORY_LANE_MAX_BYTES,
    MEMORY_SNAPSHOT_REL,
    UNTRUSTED_MEMORY_BEGIN,
    UNTRUSTED_MEMORY_END,
    build_memory_lane,
    content_is_secret_bearing,
    frame_untrusted_memory,
    select_memory_items,
)
from agentrail.context.packs import (
    build_context_pack,
    load_context_pack,
    render_context_pack_markdown,
)


# ---------------------------------------------------------------------------
# Faithful, ingest-shaped memory rows (memory_items v2 schema, #1032).
#
# These carry exactly what the ingest route persists and the GET route surfaces:
# an id, typed classification (`type`), writer attribution (`written_by`),
# `source`, `content`, `tags`, and `created_at`. A fake that dropped `type` or
# `written_by` could hide a real "typed + attributed" regression, so it does not.
# ---------------------------------------------------------------------------
def _mem(
    item_id: str,
    content: str,
    *,
    mem_type: str = "fact",
    written_by: str = "review",
    source: str = "review",
    created_at: str = "2026-07-01T00:00:00Z",
    tags=None,
):
    return {
        "id": item_id,
        "type": mem_type,
        "written_by": written_by,
        "source": source,
        "content": content,
        "tags": list(tags) if tags else [],
        "created_at": created_at,
    }


def _make_repo() -> Path:
    """Minimal git repo fixture suitable for build_context_pack (mirrors test_packs)."""
    root = Path(tempfile.mkdtemp())
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    (root / ".agentrail").mkdir()
    (root / ".agentrail" / "config.json").write_text(
        json.dumps({
            "schemaVersion": 1,
            "context": {
                "includeGlobs": ["**/*"],
                "excludeGlobs": [
                    ".git/**", ".agentrail/context/**", ".agentrail/source/**",
                    ".env", ".env.*", "**/.env", "**/.env.*",
                    "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*",
                ],
                "maxFileSizeBytes": 262144,
                "skipBinary": True,
                "respectGitIgnore": True,
                "secretRedaction": {
                    "enabled": True, "action": "exclude",
                    "denyGlobs": [".env", ".env.*", "**/.env"],
                },
                "embedding": {"mode": "disabled", "provider": None, "model": None},
                "summary": {"mode": "disabled", "provider": None, "model": None},
            },
        }, indent=2),
        encoding="utf-8",
    )
    (root / ".agentrail" / "state.json").write_text(
        json.dumps({"workflow": {"activeIssue": 1, "activePhase": "plan", "goals": []}}),
        encoding="utf-8",
    )
    (root / "CONTEXT.md").write_text("# Context\n\nIssue #1 context.\n", encoding="utf-8")
    (root / "TASTE.md").write_text("# Taste\n\nEvidence over claims.\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "module_1.py").write_text("# module 1 for issue #1\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "init"], check=True)
    build_index(root)
    return root


# ---------------------------------------------------------------------------
# AC1 — a memory written through the ingest route appears, typed + attributed,
# in a subsequently built pack's memory lane.
# ---------------------------------------------------------------------------
class MemoryLaneAppearsInPackTests(unittest.TestCase):
    def test_ingested_memory_appears_typed_and_attributed_in_pack(self) -> None:
        root = _make_repo()
        # A row exactly as the ingest route would persist it (typed + attributed).
        ingested = _mem(
            "id-decision-1",
            "We build Jace on the Eve framework.",
            mem_type="decision",
            written_by="jace",
            source="chat",
        )
        result = build_context_pack(root, "issue", 1, "plan", memory_items=[ingested])

        # The full pack (with section lanes) is persisted; reload the real artifact.
        pack = load_context_pack(root, result["packId"])
        lane = pack["memoryLane"]
        self.assertEqual(len(lane), 1, "the ingested memory should populate the lane")
        entry = lane[0]
        # Typed: the decision classification survives into the lane.
        self.assertEqual(entry["type"], "decision")
        # Attributed: the writer is carried through, not dropped.
        self.assertEqual(entry["writtenBy"], "jace")
        # Content preserved and the advisory reason present (every inclusion needs one).
        self.assertEqual(entry["content"], "We build Jace on the Eve framework.")
        self.assertIn("reason", entry)
        self.assertTrue(entry["reason"], "memory lane items must carry a reason tag")
        # Rendered markdown shows the typed, attributed line inside the lane.
        md = render_context_pack_markdown(pack)
        self.assertIn("[decision]", md)
        self.assertIn("(by jace)", md)
        self.assertIn("We build Jace on the Eve framework.", md)


# ---------------------------------------------------------------------------
# AC2 — deterministic selection + byte cap: same inputs => byte-identical lane.
# ---------------------------------------------------------------------------
class MemoryLaneDeterminismTests(unittest.TestCase):
    def test_lane_is_byte_identical_across_two_builds(self) -> None:
        # Deliberately shuffled input order across the two builds: a total sort key
        # must make the rendered lane byte-identical regardless of input order.
        items_a = [
            _mem("b", "beta fact", mem_type="fact", created_at="2026-07-01T00:00:00Z"),
            _mem("a", "alpha decision", mem_type="decision", created_at="2026-07-02T00:00:00Z"),
            _mem("c", "gamma preference", mem_type="preference", created_at="2026-07-03T00:00:00Z"),
        ]
        items_b = list(reversed(items_a))

        lane_a = build_memory_lane(Path("/nonexistent"), items=items_a)
        lane_b = build_memory_lane(Path("/nonexistent"), items=items_b)

        frame_a = frame_untrusted_memory(lane_a)
        frame_b = frame_untrusted_memory(lane_b)
        self.assertEqual(
            frame_a.encode("utf-8"),
            frame_b.encode("utf-8"),
            "same inputs (reordered) must yield a byte-identical lane",
        )
        # And the deterministic order is the authority order: decision, preference, fact.
        self.assertEqual([i["type"] for i in lane_a], ["decision", "preference", "fact"])

    def test_over_cap_items_are_dropped_deterministically(self) -> None:
        # Two items, each ~100 content bytes, with a cap that admits only one.
        big = "x" * 100
        items = [
            _mem("keep", big, mem_type="decision", created_at="2026-07-02T00:00:00Z"),
            _mem("drop", big, mem_type="fact", created_at="2026-07-01T00:00:00Z"),
        ]
        lane1 = select_memory_items(items, max_bytes=150)
        lane2 = select_memory_items(list(reversed(items)), max_bytes=150)
        # Whole-item cap: only the higher-authority "decision" fits; "fact" is dropped.
        self.assertEqual([i["id"] for i in lane1], ["keep"])
        self.assertEqual(lane1, lane2, "truncation must be order-independent")
        # Sanity: the default cap is a real bound, not unbounded.
        self.assertGreater(MEMORY_LANE_MAX_BYTES, 0)


# ---------------------------------------------------------------------------
# AC3 — the lane is delimited/framed as untrusted advisory content.
# ---------------------------------------------------------------------------
class MemoryLaneUntrustedFramingTests(unittest.TestCase):
    def test_lane_is_framed_untrusted_and_advisory(self) -> None:
        lane = build_memory_lane(
            Path("/nonexistent"),
            items=[_mem("d1", "prefer names over IDs", mem_type="preference", written_by="review")],
        )
        framed = frame_untrusted_memory(lane)

        # Explicit untrusted delimiters wrap the body (reuses the #1035 fence shape).
        self.assertIn(UNTRUSTED_MEMORY_BEGIN, framed)
        self.assertIn(UNTRUSTED_MEMORY_END, framed)
        begin = framed.index(UNTRUSTED_MEMORY_BEGIN)
        end = framed.index(UNTRUSTED_MEMORY_END)
        self.assertLess(begin, end, "content must sit BETWEEN the delimiters")
        self.assertIn("prefer names over IDs", framed[begin:end])

        # Framed as DATA-not-instructions and advisory (never outranks code/issue).
        lowered = framed.lower()
        self.assertIn("untrusted", lowered)
        self.assertIn("advisory", lowered)
        self.assertIn("not as", lowered.replace("not\n", "not "))  # "NOT as instructions"
        self.assertIn("outrank", lowered)

    def test_empty_lane_is_still_framed(self) -> None:
        # Even with no memory, the section renders the untrusted frame so the
        # boundary is always present (a reader can't be tricked by an unframed gap).
        framed = frame_untrusted_memory([])
        self.assertIn(UNTRUSTED_MEMORY_BEGIN, framed)
        self.assertIn(UNTRUSTED_MEMORY_END, framed)
        self.assertIn("(no memory items)", framed)


# ---------------------------------------------------------------------------
# AC4 — a secret-bearing memory item can NEVER reach a lane. The read-side
# filter is explicit and tested directly.
# ---------------------------------------------------------------------------
class MemoryLaneSecretFilterTests(unittest.TestCase):
    # Credential-shaped strings, one per detector family the compiler screens.
    SECRETS = [
        "AKIAIOSFODNN7EXAMPLE",  # aws access key
        "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB",  # github token
        "sk-0123456789abcdef0123456789abcdef",  # api key
        "postgres://user:pass@host:5432/db",  # database url
    ]

    def test_filter_flags_secret_content_directly(self) -> None:
        for secret in self.SECRETS:
            self.assertTrue(
                content_is_secret_bearing(f"the key is {secret} keep it"),
                f"detector should flag secret-bearing content: {secret!r}",
            )
        self.assertFalse(
            content_is_secret_bearing("prefer names over IDs in the UI"),
            "benign advisory content must not be flagged",
        )

    def test_secret_item_never_reaches_the_lane(self) -> None:
        items = [
            _mem("safe", "prefer names over IDs", mem_type="preference"),
            _mem("leak", f"api key sk-0123456789abcdef0123456789abcdef", mem_type="decision"),
        ]
        lane = select_memory_items(items)
        ids = [i["id"] for i in lane]
        self.assertIn("safe", ids)
        self.assertNotIn("leak", ids, "a secret-bearing item must be filtered out")
        # And its content never appears anywhere in the rendered, framed lane.
        framed = frame_untrusted_memory(lane)
        self.assertNotIn("sk-0123456789abcdef0123456789abcdef", framed)

    def test_secret_item_filtered_even_in_a_built_pack(self) -> None:
        root = _make_repo()
        result = build_context_pack(
            root, "issue", 1, "plan",
            memory_items=[
                _mem("safe", "we use Eve for Jace", mem_type="decision", written_by="jace"),
                _mem("leak", "token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", mem_type="fact"),
            ],
        )
        pack = load_context_pack(root, result["packId"])
        lane_ids = [i["id"] for i in pack["memoryLane"]]
        self.assertIn("safe", lane_ids)
        self.assertNotIn("leak", lane_ids)
        md = render_context_pack_markdown(pack)
        self.assertNotIn("ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", md)


# ---------------------------------------------------------------------------
# Snapshot read path — a malformed/absent snapshot yields an empty lane, never
# an exception (non-fatal, like the index/state readers).
# ---------------------------------------------------------------------------
class MemorySnapshotReadTests(unittest.TestCase):
    def test_missing_snapshot_yields_empty_lane(self) -> None:
        self.assertEqual(build_memory_lane(Path(tempfile.mkdtemp())), [])

    def test_valid_snapshot_is_read(self) -> None:
        root = Path(tempfile.mkdtemp())
        snap = root / MEMORY_SNAPSHOT_REL
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text(
            json.dumps({"items": [_mem("s1", "snapshot memory", mem_type="fact")]}),
            encoding="utf-8",
        )
        lane = build_memory_lane(root)
        self.assertEqual(len(lane), 1)
        self.assertEqual(lane[0]["content"], "snapshot memory")

    def test_malformed_snapshot_yields_empty_lane(self) -> None:
        root = Path(tempfile.mkdtemp())
        snap = root / MEMORY_SNAPSHOT_REL
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text("{ this is not json", encoding="utf-8")
        self.assertEqual(build_memory_lane(root), [])


if __name__ == "__main__":
    unittest.main()
