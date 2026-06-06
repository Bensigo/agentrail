# Context Compiler Contract

The Context Compiler turns a task, issue, PR, error, review, or resume request into bounded context evidence for agents, reviewers, server ingestion, and later provider integrations.

This contract extends existing context query and context pack JSON. It does not replace the legacy fields that current consumers read.

## Contract Version

Compiler data lives under a top-level `compiler` object:

```json
{
  "compiler": {
    "contractVersion": "context-compiler-v1"
  }
}
```

Older consumers may ignore `compiler`. New consumers should prefer `compiler` when present and fall back to legacy fields when it is absent.

## Stable Sections

Every `context-compiler-v1` object has these sections:

- `input`: normalized request text, phase, issue target, and PR target.
- `anchors`: deterministic handles extracted from the request or target metadata.
- `candidates`: source evidence, procedural guidance, and excluded context considered by compilation.
- `graphExpansion`: deterministic relationship traversal metadata. It may be `not_available` until the Code Graph exists.
- `policy`: source custody, redaction, authority, freshness, and denied-source handling.
- `rerank`: final ordering metadata for selected and rejected candidate IDs.
- `tokenPack`: retrieval and token budget, selected candidate IDs, omitted candidate IDs, token estimate, and packing strategy.
- `citations`: citation coverage and candidate-to-citation references.
- `reasons`: reason coverage and candidate-to-reason references.
- `metrics`: candidate counts, selected counts, excluded counts, citation coverage, reason coverage, and stale or denied leakage.
- `compatibility`: mapping from legacy JSON fields to compiler-facing fields.

Initial slices may emit empty arrays, `null` estimates, or `not_available` status for graph expansion, reranking providers, and token estimation. They must not invent relationships or provider decisions.

## Anchors

Anchors are strong retrieval handles extracted from request text or target metadata:

```json
{
  "kind": "issue",
  "value": "100",
  "normalized": "#100",
  "source": "target",
  "confidence": "exact",
  "reason": "Context target is issue #100."
}
```

Supported anchor kinds include `issue`, `pull_request`, `path`, and `command`. Future compiler slices may add `symbol`, `test`, `error`, `label`, and `codebase_unit`.

Anchors must be deterministic for the same input and must not expose denied or redacted secret-bearing values.

## Candidates

Candidates represent what the compiler considered:

```json
{
  "id": "chunk:docs/agents/context-engine.md#provider-facing-commands",
  "kind": "source_evidence",
  "sourceType": "agent_doc",
  "path": "docs/agents/context-engine.md",
  "citation": "docs/agents/context-engine.md#provider-facing-commands",
  "reason": "BM25 keyword match; high authority source",
  "score": {
    "final": 16.6
  },
  "policy": {
    "visibility": "local",
    "authority": "high",
    "freshness": "current",
    "redactions": []
  }
}
```

Candidate kinds:

- `source_evidence`: code, docs, memory, run artifacts, state, issues, PRs, PRDs, milestones, and index metadata.
- `procedural_guidance`: skills, tools, review gates, and workflow guidance.
- `excluded_context`: denied, skipped, stale, policy-excluded, or unavailable context.

Source evidence can justify implementation or review decisions. Procedural guidance can tell the agent how to work, but it is not evidence that code behavior is true.

Every candidate exposed to an agent must have a citation and reason. Denied source content must not appear in a candidate body.

## Graph Expansion

Graph expansion records deterministic relationship traversal:

```json
{
  "status": "not_available",
  "maxHops": 2,
  "startedFromAnchors": [],
  "visited": [],
  "addedCandidateIds": [],
  "rejected": []
}
```

When graph expansion exists, it must start from strong anchors, record hop limits, cite deterministic evidence, and mark LLM-generated Graph Enrichment as low authority.

## Policy

Policy records custody and filtering decisions:

```json
{
  "sourceCustody": {
    "mode": "metadata_only",
    "fullSourceUploadAllowed": false,
    "snippetUploadAllowed": false,
    "reason": "Default enterprise mode does not upload full source code."
  },
  "redaction": {
    "enabled": true,
    "action": "exclude"
  },
  "authorityOrder": ["critical", "high", "normal", "low", "denied"],
  "freshnessOrder": ["current", "unknown", "stale", "expired"],
  "deniedSourceHandling": "excluded_context_only"
}
```

Default enterprise mode does not upload full source code. Bounded snippets may be uploaded only when Source Custody Policy allows it. Denied sources may appear only as excluded metadata with a reason and citation.

## Rerank

Rerank records the final ordering step:

```json
{
  "status": "score_sorted",
  "method": "hybrid_lexical_rrf_authority_freshness",
  "model": null,
  "rankedCandidateIds": ["chunk:docs/agents/context-engine.md#provider-facing-commands"],
  "rejectedCandidateIds": []
}
```

Provider-backed reranking must later record provider, model, audit, cost, and failure behavior. Rerank failures must not silently drop deterministic required context.

## Token Pack

Token pack records the bounded output:

```json
{
  "budget": {
    "maxItems": 20,
    "maxTokens": 6000
  },
  "selectedCandidateIds": ["chunk:docs/agents/context-engine.md#provider-facing-commands"],
  "omittedCandidateIds": [],
  "estimatedTokens": null,
  "strategy": "compat_pack_sections_until_token_estimator_exists"
}
```

Budgets must be explicit even before advanced token estimation exists. Omissions due to budget must be explainable.

## Citations, Reasons, And Metrics

The contract keeps citation and reason coverage measurable:

```json
{
  "citations": {
    "coverage": 1.0,
    "items": [
      {
        "candidateId": "chunk:docs/agents/context-engine.md#provider-facing-commands",
        "citation": "docs/agents/context-engine.md#provider-facing-commands"
      }
    ],
    "missingCandidateIds": []
  },
  "reasons": {
    "coverage": 1.0,
    "items": [
      {
        "candidateId": "chunk:docs/agents/context-engine.md#provider-facing-commands",
        "reason": "BM25 keyword match; high authority source"
      }
    ],
    "missingCandidateIds": []
  },
  "metrics": {
    "citationCoverage": 1.0,
    "reasonCoverage": 1.0,
    "candidateCount": 1,
    "selectedCount": 1,
    "excludedCount": 0,
    "staleOrDeniedLeakage": {
      "count": 0,
      "paths": [],
      "items": []
    }
  }
}
```

Evaluation should fail when required sources are missed, stale or denied sources leak into included context, or top results lack citations or reasons.

## Compatibility Path

Existing fields remain stable:

- `context.query`: `schemaVersion`, `command`, `target`, `query`, `limit`, `generatedAt`, `index`, `provider`, `audit`, `results`, and `excluded`.
- `context.build`: `schemaVersion`, `command`, `packId`, `target`, `generatedAt`, `jsonPath`, `markdownPath`, `index`, `provider`, and `audit`.
- Saved context packs: existing section arrays, `included`, `excluded`, `retrievalBudget`, `provider`, and `audit`.

Compiler mappings:

```json
{
  "legacyFieldsPreserved": true,
  "queryResultsMapTo": "compiler.candidates[kind=source_evidence]",
  "queryExcludedMapTo": "compiler.candidates[kind=excluded_context]",
  "packIncludedMapTo": "compiler.tokenPack.selectedCandidateIds",
  "packExcludedMapTo": "compiler.candidates[kind=excluded_context]",
  "skillsMapTo": "compiler.candidates[kind=procedural_guidance]"
}
```

## Query Result Example

```json
{
  "schemaVersion": 1,
  "command": "context.query",
  "target": {
    "kind": "query",
    "query": "issue #100 context compiler contract src/provider.py"
  },
  "query": "issue #100 context compiler contract src/provider.py",
  "limit": 3,
  "generatedAt": "2026-06-06T02:00:00.000Z",
  "index": {
    "version": "context-index-v1",
    "builtAt": "2026-06-06T01:59:59.000Z"
  },
  "provider": {
    "mode": "disabled",
    "provider": null,
    "model": null
  },
  "audit": {
    "event": "context_query",
    "citation": ".agentrail/context/audit/events.jsonl"
  },
  "results": [
    {
      "rank": 1,
      "kind": "indexed_context",
      "sourceType": "agent_doc",
      "path": "docs/agents/context-engine.md",
      "citation": "docs/agents/context-engine.md#provider-facing-commands",
      "reason": "BM25 keyword match; high authority source",
      "score": {
        "final": 16.6
      }
    }
  ],
  "excluded": [],
  "compiler": {
    "contractVersion": "context-compiler-v1",
    "input": {
      "kind": "query",
      "text": "issue #100 context compiler contract src/provider.py",
      "phase": null,
      "targetIssue": 100,
      "targetPullRequest": null
    },
    "anchors": [
      {
        "kind": "issue",
        "value": "100",
        "normalized": "#100",
        "source": "input",
        "confidence": "exact",
        "reason": "Issue reference found in task text."
      },
      {
        "kind": "path",
        "value": "src/provider.py",
        "normalized": "src/provider.py",
        "source": "input",
        "confidence": "exact",
        "reason": "Repo-relative path found in task text."
      }
    ],
    "candidates": [
      {
        "id": "chunk:docs/agents/context-engine.md#provider-facing-commands",
        "kind": "source_evidence",
        "sourceType": "agent_doc",
        "path": "docs/agents/context-engine.md",
        "citation": "docs/agents/context-engine.md#provider-facing-commands",
        "reason": "BM25 keyword match; high authority source",
        "policy": {
          "visibility": "local",
          "authority": "high",
          "freshness": "current",
          "redactions": []
        }
      }
    ],
    "graphExpansion": {
      "status": "not_available",
      "maxHops": 2,
      "startedFromAnchors": [],
      "visited": [],
      "addedCandidateIds": [],
      "rejected": []
    },
    "policy": {
      "sourceCustody": {
        "mode": "metadata_only",
        "fullSourceUploadAllowed": false,
        "snippetUploadAllowed": false,
        "reason": "Default enterprise mode does not upload full source code."
      },
      "redaction": {
        "enabled": true,
        "action": "exclude"
      },
      "authorityOrder": ["critical", "high", "normal", "low", "denied"],
      "freshnessOrder": ["current", "unknown", "stale", "expired"],
      "deniedSourceHandling": "excluded_context_only"
    },
    "rerank": {
      "status": "score_sorted",
      "method": "hybrid_lexical_rrf_authority_freshness",
      "model": null,
      "rankedCandidateIds": ["chunk:docs/agents/context-engine.md#provider-facing-commands"],
      "rejectedCandidateIds": []
    },
    "tokenPack": {
      "budget": {
        "maxItems": 3,
        "maxTokens": null
      },
      "selectedCandidateIds": ["chunk:docs/agents/context-engine.md#provider-facing-commands"],
      "omittedCandidateIds": [],
      "estimatedTokens": null,
      "strategy": "compat_max_items_until_token_estimator_exists"
    },
    "citations": {
      "coverage": 1.0,
      "items": [
        {
          "candidateId": "chunk:docs/agents/context-engine.md#provider-facing-commands",
          "citation": "docs/agents/context-engine.md#provider-facing-commands"
        }
      ],
      "missingCandidateIds": []
    },
    "reasons": {
      "coverage": 1.0,
      "items": [
        {
          "candidateId": "chunk:docs/agents/context-engine.md#provider-facing-commands",
          "reason": "BM25 keyword match; high authority source"
        }
      ],
      "missingCandidateIds": []
    },
    "metrics": {
      "citationCoverage": 1.0,
      "reasonCoverage": 1.0,
      "candidateCount": 1,
      "selectedCount": 1,
      "excludedCount": 0,
      "staleOrDeniedLeakage": {
        "count": 0,
        "paths": [],
        "items": []
      }
    },
    "compatibility": {
      "legacyFieldsPreserved": true,
      "queryResultsMapTo": "compiler.candidates[kind=source_evidence]",
      "queryExcludedMapTo": "compiler.candidates[kind=excluded_context]"
    }
  }
}
```

## Context Pack Result Example

```json
{
  "schemaVersion": 1,
  "command": "context.build",
  "packId": "issue-100-execute-20260606T020000000Z",
  "target": {
    "kind": "issue",
    "number": 100,
    "phase": "execute"
  },
  "generatedAt": "2026-06-06T02:00:00.000Z",
  "jsonPath": ".agentrail/context/packs/issue-100-execute-20260606T020000000Z.json",
  "markdownPath": ".agentrail/context/packs/issue-100-execute-20260606T020000000Z.md",
  "index": {
    "version": "context-index-v1",
    "builtAt": "2026-06-06T01:59:59.000Z"
  },
  "provider": {
    "mode": "disabled",
    "provider": null,
    "model": null
  },
  "audit": {
    "event": "generated_context_pack",
    "citation": ".agentrail/context/audit/events.jsonl"
  },
  "compiler": {
    "contractVersion": "context-compiler-v1",
    "input": {
      "kind": "issue",
      "text": "issue #100 execute context pack required context likely files docs memory prior mistakes active state tools skills excluded context open questions",
      "phase": "execute",
      "targetIssue": 100,
      "targetPullRequest": null
    },
    "anchors": [
      {
        "kind": "issue",
        "value": "100",
        "normalized": "#100",
        "source": "target",
        "confidence": "exact",
        "reason": "Context target is issue #100."
      }
    ],
    "candidates": [
      {
        "id": "CONTEXT.md",
        "kind": "source_evidence",
        "sourceType": "context_doc",
        "path": "CONTEXT.md",
        "citation": "CONTEXT.md",
        "reason": "Included as required local AgentRail context for visible state and quality guidance.",
        "policy": {
          "visibility": "local",
          "authority": "unknown",
          "freshness": "unknown",
          "redactions": []
        }
      },
      {
        "id": "skills/backend-api/SKILL.md",
        "kind": "procedural_guidance",
        "sourceType": "skill",
        "path": "skills/backend-api/SKILL.md",
        "citation": "skills/backend-api/SKILL.md",
        "reason": "Included so agents can see available local skill guidance for this task.",
        "policy": {
          "visibility": "local",
          "authority": "unknown",
          "freshness": "unknown",
          "redactions": []
        }
      }
    ],
    "graphExpansion": {
      "status": "not_available",
      "maxHops": 2,
      "startedFromAnchors": [],
      "visited": [],
      "addedCandidateIds": [],
      "rejected": []
    },
    "policy": {
      "sourceCustody": {
        "mode": "metadata_only",
        "fullSourceUploadAllowed": false,
        "snippetUploadAllowed": false,
        "reason": "Default enterprise mode does not upload full source code."
      },
      "redaction": {
        "enabled": true,
        "action": "exclude"
      },
      "authorityOrder": ["critical", "high", "normal", "low", "denied"],
      "freshnessOrder": ["current", "unknown", "stale", "expired"],
      "deniedSourceHandling": "excluded_context_only"
    },
    "rerank": {
      "status": "score_sorted",
      "method": "hybrid_lexical_rrf_authority_freshness",
      "model": null,
      "rankedCandidateIds": ["CONTEXT.md", "skills/backend-api/SKILL.md"],
      "rejectedCandidateIds": []
    },
    "tokenPack": {
      "budget": {
        "maxItems": 20,
        "maxTokens": 6000
      },
      "selectedCandidateIds": ["CONTEXT.md", "skills/backend-api/SKILL.md"],
      "omittedCandidateIds": [],
      "estimatedTokens": null,
      "strategy": "compat_pack_sections_until_token_estimator_exists"
    },
    "citations": {
      "coverage": 1.0,
      "items": [
        {
          "candidateId": "CONTEXT.md",
          "citation": "CONTEXT.md"
        }
      ],
      "missingCandidateIds": []
    },
    "reasons": {
      "coverage": 1.0,
      "items": [
        {
          "candidateId": "CONTEXT.md",
          "reason": "Included as required local AgentRail context for visible state and quality guidance."
        }
      ],
      "missingCandidateIds": []
    },
    "metrics": {
      "citationCoverage": 1.0,
      "reasonCoverage": 1.0,
      "candidateCount": 2,
      "selectedCount": 2,
      "excludedCount": 0,
      "staleOrDeniedLeakage": {
        "count": 0,
        "paths": [],
        "items": []
      }
    },
    "compatibility": {
      "legacyFieldsPreserved": true,
      "generatedPackJsonPath": ".agentrail/context/packs/issue-100-execute-20260606T020000000Z.json",
      "generatedPackMarkdownPath": ".agentrail/context/packs/issue-100-execute-20260606T020000000Z.md",
      "packIncludedMapTo": "compiler.tokenPack.selectedCandidateIds",
      "packExcludedMapTo": "compiler.candidates[kind=excluded_context]",
      "skillsMapTo": "compiler.candidates[kind=procedural_guidance]"
    }
  }
}
```

The saved context pack at `jsonPath` keeps the existing section arrays and also stores the same `compiler` object.

## Verification Boundaries

These tests should protect the contract boundary:

- `tests/cli/test_context_cli.py`: provider-facing CLI JSON shape for query, build, show, explain, and evaluate.
- `tests/context/test_context_modules.py`: module-level context query, context pack, evaluation, redaction, and source inventory behavior.
- `bash scripts/test-context-query`: public context query behavior, citations, reasons, exclusions, and score metadata.
- `bash scripts/test-context-packs`: context pack JSON and Markdown behavior, included sections, excluded sections, goals, skills, and audit metadata.
- `bash scripts/test-context-evaluation`: retrieval quality metrics and required-source inclusion.
- `bash scripts/test-context-privacy`: denied source and redaction behavior.
- `bash scripts/test-python`: broad Python unit test suite.

Tests should assert observable output at CLI or module boundaries. They should not depend on private scoring details unless the field is part of this contract.
