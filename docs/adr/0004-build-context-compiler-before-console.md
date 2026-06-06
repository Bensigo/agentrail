# Build Context Compiler Before Console

AgentRail should build the Context Compiler and local deterministic graph index before the server console and dashboard surface. The first milestone should define the compiler contract, extract code graph data locally, enforce freshness/authority/security policy, rerank, pack context under token budget, and emit citations and metrics.

The Agent Operations Console depends on trustworthy run, context, graph, cost, and audit events. Building the console first would create UI around immature retrieval data and hide the core product risk.
