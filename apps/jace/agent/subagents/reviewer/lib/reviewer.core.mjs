// The reviewer subagent's structured output contract — the "review" — plus
// its validator. No I/O, no framework imports — mirrors triage.core.mjs /
// qa.core.mjs so the contract is unit-testable without booting Eve.
//
// REVIEW_SCHEMA is a plain JSON Schema object handed to Eve as the reviewer
// agent's `outputSchema`, so the child runs in task mode and the framework
// forces the model's final answer into this shape.
//
// The shape is PURELY ADVISORY (spec): `findings` are line-level review
// comments root can relay and, on the owner's go, post via `post_pr_review`;
// `issueDrafts` are house-format drafts for anything too big for a PR
// comment, which root offers through its own gated issue-filing tool (this
// subagent never files anything itself — the escalation prose lives in
// instructions.md, kept out of this file deliberately: identifiers and
// comments here must never spell the write-path strings the
// no-second-write-path guardrail scans for).

export const REVIEW_VERDICTS = ["reviewed", "degraded"];
export const REVIEW_SEVERITIES = ["blocker", "major", "minor", "nit"];

// Cap on findings per review — enforced both structurally (maxItems below)
// and by the validator, so a malformed/oversized response is rejected the
// same way whether it violates the JSON Schema hint or slips past it.
export const MAX_FINDINGS = 10;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "issueDrafts", "degraded"],
  properties: {
    verdict: {
      type: "string",
      enum: REVIEW_VERDICTS,
      description:
        "'reviewed' = the diff was read and judged (zero findings is a " +
        "legitimate 'reviewed', not a failure); 'degraded' = the diff " +
        "could not be read at all (auth, not-found, or another fetch " +
        "failure) — report the gap honestly via `degraded` instead of " +
        "guessing at the PR's contents.",
    },
    summary: {
      type: "string",
      description: "One-paragraph plain-language summary the parent can render in the channel voice.",
    },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      description:
        "Review comments on the CHANGED code only, ranked by severity, " +
        `capped at ${MAX_FINDINGS}. Empty when verdict is 'degraded'.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "severity", "finding", "suggestedComment", "escalate"],
        properties: {
          path: { type: "string", description: "Changed file path the finding is about." },
          line: {
            type: ["number", "null"],
            description: "Line number in the new (RIGHT) side of the diff, or null for a file-level finding.",
          },
          severity: {
            type: "string",
            enum: REVIEW_SEVERITIES,
            description:
              "blocker = must fix before merge (bug, security, broken " +
              "behavior); major = should fix (real but non-blocking); " +
              "minor = worth fixing, low impact; nit = style/preference.",
          },
          finding: {
            type: "string",
            description: "What's wrong and why, in your own words.",
          },
          suggestedComment: {
            type: "string",
            description:
              "The exact line-comment text to post if approved — courteous, " +
              "specific, actionable, no filler.",
          },
          escalate: {
            type: "boolean",
            description:
              "True only when the fix is clearly bigger than this PR's own " +
              "scope. Every escalate:true finding must have exactly one " +
              "matching entry in issueDrafts, in the same relative order.",
          },
        },
      },
    },
    issueDrafts: {
      type: "array",
      description:
        "House-format drafts, one per escalate:true finding, in the same " +
        "relative order. The parent offers each through its own gated " +
        "issue-filing tool; this subagent never files anything itself.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "parent",
          "requiredContext",
          "whatToBuild",
          "acceptanceCriteria",
          "verificationEvidence",
        ],
        properties: {
          title: { type: "string", description: "Concise issue title." },
          parent: { type: "string", description: "Parent epic/milestone, or \"\" when none applies." },
          requiredContext: {
            type: "string",
            description: "Why this matters — the finding(s) it grows out of, and any constraints.",
          },
          whatToBuild: {
            type: "string",
            description: "The end-to-end fix to build, described by behavior, not file paths.",
          },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
            description:
              "Plain strings, each an observable/testable criterion; the " +
              "parent renders them as `- [ ] ACn: ...` checkboxes. At " +
              "least one is required — the factory's intake gate rejects " +
              "an issue whose Acceptance criteria section has none.",
          },
          verificationEvidence: {
            type: "string",
            description: "How completion of this fix would be verified.",
          },
        },
      },
    },
    degraded: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["reason"],
      properties: {
        reason: {
          type: "string",
          description: "Why the diff could not be read — the retrieval gap, never a guess at the PR's contents.",
        },
      },
      description: "Non-null exactly when verdict is 'degraded'; null otherwise.",
    },
  },
};

/**
 * Structural + coupling validation for a review (JSON Schema alone cannot
 * express the couplings: verdict<->findings/issueDrafts/degraded,
 * escalate<->issueDrafts count). Returns { ok, errors }.
 *
 * @param {unknown} review
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateReview(review) {
  const errors = [];
  const push = (msg) => errors.push(msg);
  const isStr = (v) => typeof v === "string" && v.length > 0;

  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    return { ok: false, errors: ["review must be an object"] };
  }

  if (!REVIEW_VERDICTS.includes(review.verdict)) {
    push(`verdict must be one of: ${REVIEW_VERDICTS.join(", ")}`);
  }
  if (!isStr(review.summary)) push("summary must be a non-empty string");

  let findingsShapeOk = Array.isArray(review.findings);
  if (!findingsShapeOk) {
    push("findings must be an array");
  } else {
    if (review.findings.length > MAX_FINDINGS) {
      push(`findings must have at most ${MAX_FINDINGS} entries`);
    }
    review.findings.forEach((f, i) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) {
        push(`findings[${i}] must be an object`);
        findingsShapeOk = false;
        return;
      }
      if (!isStr(f.path)) push(`findings[${i}].path must be a non-empty string`);
      if (f.line !== null && typeof f.line !== "number") {
        push(`findings[${i}].line must be a number or null`);
      }
      if (!REVIEW_SEVERITIES.includes(f.severity)) {
        push(`findings[${i}].severity must be one of: ${REVIEW_SEVERITIES.join(", ")}`);
      }
      if (!isStr(f.finding)) push(`findings[${i}].finding must be a non-empty string`);
      if (!isStr(f.suggestedComment)) {
        push(`findings[${i}].suggestedComment must be a non-empty string`);
      }
      if (typeof f.escalate !== "boolean") push(`findings[${i}].escalate must be a boolean`);
    });
  }

  let draftsShapeOk = Array.isArray(review.issueDrafts);
  if (!draftsShapeOk) {
    push("issueDrafts must be an array");
  } else {
    review.issueDrafts.forEach((d, i) => {
      if (d === null || typeof d !== "object" || Array.isArray(d)) {
        push(`issueDrafts[${i}] must be an object`);
        draftsShapeOk = false;
        return;
      }
      if (!isStr(d.title)) push(`issueDrafts[${i}].title must be a non-empty string`);
      if (typeof d.parent !== "string") push(`issueDrafts[${i}].parent must be a string`);
      if (typeof d.requiredContext !== "string") {
        push(`issueDrafts[${i}].requiredContext must be a string`);
      }
      if (!isStr(d.whatToBuild)) push(`issueDrafts[${i}].whatToBuild must be a non-empty string`);
      if (
        !Array.isArray(d.acceptanceCriteria) ||
        d.acceptanceCriteria.length === 0 ||
        !d.acceptanceCriteria.every(isStr)
      ) {
        push(`issueDrafts[${i}].acceptanceCriteria must be a non-empty array of non-empty strings`);
      }
      if (!isStr(d.verificationEvidence)) {
        push(`issueDrafts[${i}].verificationEvidence must be a non-empty string`);
      }
    });
  }

  if (review.degraded !== null) {
    if (review.degraded === undefined || typeof review.degraded !== "object" || Array.isArray(review.degraded)) {
      push("degraded must be an object or null");
    } else if (!isStr(review.degraded.reason)) {
      push("degraded.reason must be a non-empty string when degraded is set");
    }
  }

  // Verdict couplings — the anti-confabulation core, same posture as
  // triage/qa: a subagent that couldn't do its job must say so structurally,
  // not just in prose.
  if (review.verdict === "degraded") {
    if (review.degraded === null || review.degraded === undefined) {
      push("verdict 'degraded' requires a non-null degraded");
    }
    if (findingsShapeOk && review.findings.length > 0) {
      push("verdict 'degraded' must carry zero findings — the diff was never read");
    }
    if (draftsShapeOk && review.issueDrafts.length > 0) {
      push("verdict 'degraded' must carry zero issueDrafts — the diff was never read");
    }
  } else if (review.degraded !== null && review.degraded !== undefined) {
    push("degraded must be null unless verdict is 'degraded'");
  }

  // escalate:true findings <-> issueDrafts: the schema carries no explicit
  // link field, so the checkable invariant is a COUNT match — root and this
  // module both treat emission order as the pairing (the Nth escalate:true
  // finding pairs with the Nth issueDraft; see instructions.md).
  if (findingsShapeOk && draftsShapeOk) {
    const escalatedCount = review.findings.filter((f) => f && f.escalate === true).length;
    if (escalatedCount !== review.issueDrafts.length) {
      push(
        `escalate:true findings (${escalatedCount}) must have exactly one matching issueDraft each — got ${review.issueDrafts.length} issueDrafts`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
