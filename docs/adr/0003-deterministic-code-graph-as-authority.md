# Deterministic Code Graph As Authority

AgentRail's authoritative graph relationships should come from deterministic evidence: parsed code symbols, imports, references, tests, git history, issues, PRs, run evidence, ownership config, and explicit docs. LLM-generated graph edges may exist only as low-authority enrichment and must not outrank deterministic code, tests, docs, ownership, or run evidence.

This avoids context rot and hallucinated relationships becoming part of the retrieval source of truth.
