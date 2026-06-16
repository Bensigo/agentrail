"""Connectors — the two-way seam between external tools and the Issue Queue.

A **Connector** (CONTEXT.md, ADR 0010) brings *human-created* work from an
external tool (GitHub, Linear, Discord) **into the Issue Queue** and **reports
results back** — two-way, never one-way. It embodies **Execution-Only Autonomy**:
connectors ingest goals humans defined, the agent never invents them.

The shared interface lives in :mod:`agentrail.connectors.base`; each adapter is a
deep module behind that small surface. The GitHub adapter
(:mod:`agentrail.connectors.github`) is the single, consolidated home of the
``gh`` CLI client (formerly ``agentrail/afk/github.py``) — there is no second
GitHub client.
"""
