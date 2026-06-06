# Context Compiler Over Basic RAG

AgentRail retrieval will be modeled as a Context Compiler, not as basic vector RAG or generic GraphRAG. A retrieval request starts from a task, issue, PR, error, or review; extracts strong anchors; retrieves candidates; expands a deterministic code graph with hop limits; applies authority, freshness, and security policy; reranks; packs to a token budget; and emits citations, reasons, and evaluation metrics.

This decision exists because top-k cosine retrieval returns noisy context for code, while unbounded graph traversal can become a different noise source. The product goal is the smallest useful cited context pack, not the largest plausible context set.
