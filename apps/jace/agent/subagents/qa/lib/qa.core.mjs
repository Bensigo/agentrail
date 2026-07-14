// Pure core for the qa subagent: the advisory contract (QA_SCHEMA) and its
// validator. No I/O, no framework imports — mirrors triage.core.mjs so the
// contract is unit-testable without booting Eve.
//
// The schema is a plain JSON-Schema object (NOT zod): Eve's defineAgent
// consumes it directly as outputSchema, which runs the subagent in task mode
// and forces its final answer into this shape (spec AC1/AC2).

export const QA_VERDICTS = ["passed", "issues_found", "not_verifiable"];
export const QA_SURFACES = ["ui", "api"];
export const QA_SEVERITIES = ["low", "medium", "high"];

export const QA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "summary",
    "tested",
    "findings",
    "not_verifiable_reason",
    "evidence_refs",
  ],
  properties: {
    run_id: {
      type: "string",
      description:
        "Echo, verbatim, the factory run_id whose shipped change you QA'd, if " +
        "the parent gave you one. Optional and never invented: it is a join " +
        "key so observability can pair this advisory with the run's own " +
        "outcome. Copy it exactly; omit this field when no run_id was provided.",
    },
    verdict: {
      type: "string",
      enum: QA_VERDICTS,
      description:
        "'passed' = everything exercised behaved; 'issues_found' = at least " +
        "one concrete finding; 'not_verifiable' = the app could not be tested " +
        "(missing/unreachable URL, change not deployed).",
    },
    summary: {
      type: "string",
      description:
        "One-paragraph plain-language summary the parent can render in the channel voice.",
    },
    tested: {
      type: "array",
      description: "What was actually exercised — one entry per surface probed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["surface", "target", "result"],
        properties: {
          surface: { type: "string", enum: QA_SURFACES },
          target: {
            type: "string",
            description: "Route or endpoint exercised, e.g. '/dashboard' or 'GET /api/runs'.",
          },
          result: { type: "string", description: "What happened, in one line." },
        },
      },
    },
    findings: {
      type: "array",
      description: "Observed defects only — never speculation.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "severity",
          "route",
          "repro_steps",
          "observed",
          "expected",
          "suggests_issue",
          "issue_draft",
        ],
        properties: {
          title: { type: "string", description: "One-line symptom." },
          severity: {
            type: "string",
            enum: QA_SEVERITIES,
            description:
              "high = flow blocked or data wrong; medium = degraded but passable; low = cosmetic.",
          },
          route: {
            type: "string",
            description: "Page route or endpoint path where the problem shows.",
          },
          repro_steps: {
            type: "array",
            items: { type: "string" },
            description: "Exact steps a human can replay.",
          },
          observed: {
            type: "string",
            description: "What actually renders/returns — the user-visible symptom.",
          },
          expected: { type: "string", description: "What should have happened." },
          suggests_issue: {
            type: "boolean",
            description:
              "True when the finding merits a GitHub issue. The parent decides " +
              "and files it through its own gated, human-approved write path — this subagent " +
              "never files anything.",
          },
          issue_draft: {
            type: ["object", "null"],
            description:
              "House-format draft for the parent's gated issue-filing tool; " +
              "required (non-null) exactly when suggests_issue is true.",
            additionalProperties: false,
            required: ["title", "body"],
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
          },
        },
      },
    },
    not_verifiable_reason: {
      type: ["string", "null"],
      description:
        "Required (non-null) exactly when verdict is 'not_verifiable'; null otherwise.",
    },
    evidence_refs: {
      type: "array",
      items: { type: "string" },
      description:
        "Tool observations the claims rest on, e.g. 'snapshot of /dashboard " +
        "after Save click', 'network: POST /api/settings -> 500'.",
    },
  },
};

// Structural + coupling validation for an advisory (spec §5). JSON Schema
// alone cannot express the couplings (verdict<->findings, suggests_issue<->
// issue_draft, findings<->evidence), so this validator is the enforced
// contract; the schema is the shape hint given to the model.
export function validateAdvisory(advisory) {
  const errors = [];
  const push = (msg) => errors.push(msg);
  const isStr = (v) => typeof v === "string" && v.length > 0;

  if (advisory === null || typeof advisory !== "object" || Array.isArray(advisory)) {
    return { ok: false, errors: ["advisory must be an object"] };
  }

  if (!QA_VERDICTS.includes(advisory.verdict)) {
    push(`verdict must be one of: ${QA_VERDICTS.join(", ")}`);
  }
  if (!isStr(advisory.summary)) push("summary must be a non-empty string");

  if (!Array.isArray(advisory.tested)) {
    push("tested must be an array");
  } else {
    advisory.tested.forEach((t, i) => {
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        push(`tested[${i}] must be an object`);
        return;
      }
      if (!QA_SURFACES.includes(t.surface)) {
        push(`tested[${i}].surface must be one of: ${QA_SURFACES.join(", ")}`);
      }
      if (!isStr(t.target)) push(`tested[${i}].target must be a non-empty string`);
      if (!isStr(t.result)) push(`tested[${i}].result must be a non-empty string`);
    });
  }

  if (!Array.isArray(advisory.findings)) {
    push("findings must be an array");
  } else {
    advisory.findings.forEach((f, i) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) {
        push(`findings[${i}] must be an object`);
        return;
      }
      if (!isStr(f.title)) push(`findings[${i}].title must be a non-empty string`);
      if (!QA_SEVERITIES.includes(f.severity)) {
        push(`findings[${i}].severity must be one of: ${QA_SEVERITIES.join(", ")}`);
      }
      if (!isStr(f.route)) push(`findings[${i}].route must be a non-empty string`);
      if (
        !Array.isArray(f.repro_steps) ||
        f.repro_steps.length === 0 ||
        !f.repro_steps.every(isStr)
      ) {
        push(`findings[${i}].repro_steps must be a non-empty array of non-empty strings`);
      }
      if (!isStr(f.observed)) push(`findings[${i}].observed must be a non-empty string`);
      if (!isStr(f.expected)) push(`findings[${i}].expected must be a non-empty string`);
      if (typeof f.suggests_issue !== "boolean") {
        push(`findings[${i}].suggests_issue must be a boolean`);
      }
      if (f.issue_draft !== null && f.issue_draft !== undefined) {
        if (typeof f.issue_draft !== "object" || Array.isArray(f.issue_draft)) {
          push(`findings[${i}].issue_draft must be an object or null`);
        } else {
          if (!isStr(f.issue_draft.title)) {
            push(`findings[${i}].issue_draft.title must be a non-empty string`);
          }
          if (!isStr(f.issue_draft.body)) {
            push(`findings[${i}].issue_draft.body must be a non-empty string`);
          }
        }
      }
      if (f.suggests_issue === true && (f.issue_draft === null || f.issue_draft === undefined)) {
        push(`findings[${i}] sets suggests_issue but carries no issue_draft`);
      }
    });
  }

  if (!Array.isArray(advisory.evidence_refs) || !advisory.evidence_refs.every(isStr)) {
    push("evidence_refs must be an array of non-empty strings");
  }

  // Verdict couplings — the anti-confabulation core (spec §5).
  const findingsCount = Array.isArray(advisory.findings) ? advisory.findings.length : 0;
  if (advisory.verdict === "issues_found" && findingsCount === 0) {
    push("verdict 'issues_found' requires at least one finding");
  }
  if (advisory.verdict === "passed" && findingsCount > 0) {
    push("verdict 'passed' must carry zero findings — use 'issues_found'");
  }
  if (advisory.verdict === "not_verifiable") {
    if (!isStr(advisory.not_verifiable_reason)) {
      push("verdict 'not_verifiable' requires a non-empty not_verifiable_reason");
    }
    if (findingsCount > 0) push("verdict 'not_verifiable' must carry zero findings");
  } else if (
    advisory.not_verifiable_reason !== null &&
    advisory.not_verifiable_reason !== undefined
  ) {
    push("not_verifiable_reason must be null unless verdict is 'not_verifiable'");
  }
  if (
    findingsCount > 0 &&
    (!Array.isArray(advisory.evidence_refs) || advisory.evidence_refs.length === 0)
  ) {
    push("findings require at least one evidence_ref — a finding with no observation behind it is invalid");
  }

  return { ok: errors.length === 0, errors };
}
