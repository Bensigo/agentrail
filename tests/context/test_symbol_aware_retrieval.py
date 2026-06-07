from __future__ import annotations

import unittest

from agentrail.context.index import (
    _extract_js_ts_symbols,
    _extract_python_symbols,
    code_chunks,
    symbol_chunks,
)
from agentrail.context.models import Freshness, SourceRecord


def _source(path: str = "example.py") -> SourceRecord:
    return SourceRecord(
        id=f"source:{path}",
        sourceType="code",
        path=path,
        contentHash="sha256:abc123",
        modifiedAt="2026-06-07T00:00:00Z",
        freshness=Freshness(status="current", observedAt="2026-06-07T00:00:00Z", expiresAt=None),
        authority="normal",
        visibility="local",
        linkedIssues=[],
        linkedPullRequests=[],
        chunkIds=[],
        auditRef="audit:test",
    )


PYTHON_CODE = '''import os
import sys

MAX_RETRIES = 3


def retry_with_backoff(fn, retries=MAX_RETRIES):
    """Retry a function with exponential backoff."""
    for attempt in range(retries):
        try:
            return fn()
        except Exception:
            if attempt == retries - 1:
                raise


class ConnectionPool:
    def __init__(self, size=10):
        self._pool = []
        self._size = size

    def acquire(self):
        if self._pool:
            return self._pool.pop()
        return self._create()

    def release(self, conn):
        if len(self._pool) < self._size:
            self._pool.append(conn)

    def _create(self):
        return object()


def health_check():
    pool = ConnectionPool()
    conn = pool.acquire()
    pool.release(conn)
    return True
'''

JS_CODE = '''import { connect } from './db';

const MAX_TIMEOUT = 5000;

export function fetchData(url, options) {
    return fetch(url, { ...options, timeout: MAX_TIMEOUT });
}

export async function retryFetch(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetchData(url);
        } catch (err) {
            if (i === retries - 1) throw err;
        }
    }
}

class ApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async get(path) {
        return retryFetch(`${this.baseUrl}${path}`);
    }
}
'''

UNSUPPORTED_CODE = '''
; Assembly file
section .text
global _start
_start:
    mov eax, 1
    int 0x80
'''


class PythonSymbolExtractionTests(unittest.TestCase):
    def test_extracts_functions_and_classes(self) -> None:
        lines = PYTHON_CODE.strip().split("\n")
        spans = _extract_python_symbols(lines)
        names = [(s.name, s.kind) for s in spans]
        self.assertIn(("retry_with_backoff", "function"), names)
        self.assertIn(("ConnectionPool", "class"), names)
        self.assertIn(("health_check", "function"), names)

    def test_line_ranges_cover_function_bodies(self) -> None:
        lines = PYTHON_CODE.strip().split("\n")
        spans = _extract_python_symbols(lines)
        retry = next(s for s in spans if s.name == "retry_with_backoff")
        self.assertGreater(retry.end_line, retry.start_line)
        chunk_text = "\n".join(lines[retry.start_line - 1:retry.end_line])
        self.assertIn("exponential backoff", chunk_text)
        self.assertIn("raise", chunk_text)

    def test_class_spans_include_methods(self) -> None:
        lines = PYTHON_CODE.strip().split("\n")
        spans = _extract_python_symbols(lines)
        pool_class = next(s for s in spans if s.name == "ConnectionPool")
        chunk_text = "\n".join(lines[pool_class.start_line - 1:pool_class.end_line])
        self.assertIn("def acquire", chunk_text)
        self.assertIn("def release", chunk_text)
        self.assertIn("def _create", chunk_text)


class JsTsSymbolExtractionTests(unittest.TestCase):
    def test_extracts_functions_and_classes(self) -> None:
        lines = JS_CODE.strip().split("\n")
        spans = _extract_js_ts_symbols(lines)
        names = [(s.name, s.kind) for s in spans]
        self.assertIn(("fetchData", "function"), names)
        self.assertIn(("retryFetch", "function"), names)
        self.assertIn(("ApiClient", "class"), names)

    def test_line_ranges_are_valid(self) -> None:
        lines = JS_CODE.strip().split("\n")
        spans = _extract_js_ts_symbols(lines)
        for span in spans:
            self.assertGreaterEqual(span.start_line, 1)
            self.assertGreaterEqual(span.end_line, span.start_line)
            self.assertLessEqual(span.end_line, len(lines))


class SymbolChunkTests(unittest.TestCase):
    def test_python_produces_symbol_chunks(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        self.assertIsNotNone(chunks)
        symbol_names = [c.symbol for c in chunks if c.symbol]
        self.assertIn("retry_with_backoff", symbol_names)
        self.assertIn("ConnectionPool", symbol_names)
        self.assertIn("health_check", symbol_names)

    def test_chunks_have_kind_and_symbol(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        retry_chunk = next(c for c in chunks if c.symbol == "retry_with_backoff")
        self.assertEqual(retry_chunk.kind, "function")
        pool_chunk = next(c for c in chunks if c.symbol == "ConnectionPool")
        self.assertEqual(pool_chunk.kind, "class")

    def test_chunks_have_citation_and_line_range(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        retry_chunk = next(c for c in chunks if c.symbol == "retry_with_backoff")
        self.assertIn("lib/pool.py#L", retry_chunk.citation)
        self.assertIsNotNone(retry_chunk.startLine)
        self.assertIsNotNone(retry_chunk.endLine)

    def test_chunks_have_content_hash_and_source_id(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        for chunk in chunks:
            self.assertTrue(chunk.textHash.startswith("sha256:"))
            self.assertEqual(chunk.sourceId, "source:lib/pool.py")

    def test_preamble_lines_are_captured(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        preamble = [c for c in chunks if c.kind == "module"]
        self.assertTrue(len(preamble) > 0)
        preamble_content = "\n".join(c.content for c in preamble)
        self.assertIn("import os", preamble_content)

    def test_js_produces_symbol_chunks(self) -> None:
        source = _source("src/api.js")
        chunks = symbol_chunks(source, JS_CODE, "src/api.js")
        self.assertIsNotNone(chunks)
        symbol_names = [c.symbol for c in chunks if c.symbol]
        self.assertIn("fetchData", symbol_names)
        self.assertIn("ApiClient", symbol_names)

    def test_unsupported_language_returns_none(self) -> None:
        source = _source("boot.asm")
        result = symbol_chunks(source, UNSUPPORTED_CODE, "boot.asm")
        self.assertIsNone(result)

    def test_code_chunks_fallback_for_unsupported(self) -> None:
        source = _source("boot.asm")
        chunks = code_chunks(source, UNSUPPORTED_CODE, "boot.asm")
        self.assertTrue(len(chunks) > 0)
        for chunk in chunks:
            self.assertIsNone(chunk.kind)
            self.assertIsNone(chunk.symbol)

    def test_no_stale_duplicate_chunks_on_reindex(self) -> None:
        source = _source("lib/pool.py")
        chunks_v1 = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        modified_code = PYTHON_CODE.replace("retry_with_backoff", "retry_operation")
        chunks_v2 = symbol_chunks(source, modified_code, "lib/pool.py")
        v1_ids = {c.id for c in chunks_v1}
        v2_ids = {c.id for c in chunks_v2}
        self.assertNotEqual(v1_ids, v2_ids)
        self.assertIn("chunk:lib/pool.py#function-retry_with_backoff", v1_ids)
        self.assertIn("chunk:lib/pool.py#function-retry_operation", v2_ids)
        self.assertNotIn("chunk:lib/pool.py#function-retry_with_backoff", v2_ids)

    def test_empty_file_returns_no_symbols(self) -> None:
        source = _source("empty.py")
        result = symbol_chunks(source, "", "empty.py")
        self.assertIsNone(result)

    def test_file_with_no_symbols_returns_none(self) -> None:
        source = _source("constants.py")
        result = symbol_chunks(source, "X = 1\nY = 2\n", "constants.py")
        self.assertIsNone(result)


class ChunkRecordJsonTests(unittest.TestCase):
    def test_kind_and_symbol_in_json(self) -> None:
        source = _source("lib/pool.py")
        chunks = symbol_chunks(source, PYTHON_CODE, "lib/pool.py")
        retry_chunk = next(c for c in chunks if c.symbol == "retry_with_backoff")
        data = retry_chunk.to_json()
        self.assertEqual(data["kind"], "function")
        self.assertEqual(data["symbol"], "retry_with_backoff")

    def test_line_window_chunks_have_null_kind_and_symbol(self) -> None:
        source = _source("data.txt")
        chunks = code_chunks(source, "line1\nline2\nline3\n", "data.txt")
        for chunk in chunks:
            data = chunk.to_json()
            self.assertIsNone(data["kind"])
            self.assertIsNone(data["symbol"])


if __name__ == "__main__":
    unittest.main()
