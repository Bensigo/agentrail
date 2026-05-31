# Project Memory

Project memory captures reusable context that should survive across agent runs without becoming hidden agent state.

Use this folder for operational lessons, durable preferences, recurring failure patterns, and source-linked decisions that are useful to future agents. Keep canonical product truth in `CONTEXT.md`, and keep hard-to-reverse architectural decisions in ADRs.

## Rules

- Every memory entry must include `source:` pointing to an issue, PR, ADR, file, or other reviewable artifact.
- Memory is advisory. Agents must verify it against the current code and docs before acting.
- Do not store secrets, credentials, customer data, private personal data, or temporary chat-only guesses.
- Prefer short, specific entries over broad advice.
- Remove or mark entries stale when they stop matching the project.
- Agent-created memory changes should be proposed as normal diffs for human review.

## Entry Format

```markdown
## <Specific title>

- kind: decision | lesson | failure-pattern | project-preference
- source: <issue, PR, ADR, file path, or doc link>
- confidence: verified | inferred | stale
- created_at: YYYY-MM-DD
- expires_at: optional YYYY-MM-DD or blank

<One or two paragraphs explaining what future agents need to know and when it applies.>
```

## Recall

Before non-trivial planning, implementation, or review, run:

```bash
agentrail memory recall "<task, issue, PR, feature, or keyword>"
```

If the output is relevant, cite it in the PRD, issue, PR body, or review. If it conflicts with code or current docs, prefer the current source of truth and update the stale memory entry.
