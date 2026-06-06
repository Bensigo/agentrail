# Server Control Plane With Local Indexing

AgentRail will be a server-first enterprise control plane, but default enterprise mode will not upload full source code. Repo-adjacent local indexers should extract allowed source inventory, deterministic code graph data, context-pack metadata, run events, failure and review-gate evidence, token/cost metrics, and redaction/security events; bounded cited snippets may be uploaded only when workspace policy explicitly allows it.

This preserves the dashboard and team visibility goals without making AgentRail's server the default custodian of customer source code.
