// The reviewer subagent's structured output contract — the "review" — plus
// its validator. No I/O, no framework imports — mirrors triage.core.mjs /
// qa.core.mjs so the contract is unit-testable without booting Eve.
//
// REVIEW_SCHEMA is a plain JSON Schema object handed to Eve as the reviewer
// agent's `outputSchema`, so the child runs in task mode and the framework
// forces the model's final answer into this shape.
//
// The shape is PURELY ADVISORY (spec): `findings` are line-level review
// comments root relays and posts via `post_pr_review` (which posts only the
// `blocker`/`major` ones — see that tool's own severity filter);
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

// Coverage of the goal's acceptance criteria — the vocabulary is deliberately
// about the DIFF, not the world: `not_in_diff` never claims "unmet" (the AC
// may pre-exist or land in another PR); proving an AC *works* is QA's job.
export const AC_COVERAGE_STATUSES = ["addressed", "not_in_diff", "unclear"];
export const MAX_AC_COVERAGE = 20;

// The investigation trail's allowed tools — the four context-reading tools
// wired onto this subagent (search_code, read_repo_file, file_history,
// fetch_wiki). The prompt and rendering (later tasks) are built on this
// exact list, so both its membership and its order are the contract.
export const INVESTIGATION_TOOLS = ["search_code", "read_repo_file", "file_history", "fetch_wiki"];
export const MAX_INVESTIGATED = 20;

// The four axes of judgment rendered per review. Verdicts are per-field
// vocabularies (not one shared enum) because each field's honest answers
// have a different shape.
export const JUDGMENT_FIELDS = ["simplest", "architecture", "debt", "hiddenRisks"];
export const JUDGMENT_VERDICTS = {
  simplest: ["yes", "no", "cannot_judge"],
  architecture: ["consistent", "violates", "no_decision_found", "cannot_judge"],
  debt: ["none_found", "introduces", "cannot_judge"],
  hiddenRisks: ["none_found", "found", "cannot_judge"],
};

// The one verdict per field that is a NEGATIVE/grounded claim — asserting
// the diff has a real problem. Grounded claims must cite investigated ids
// in `basis`: no investigation, no claim. `cannot_judge` is always honest
// and never requires grounding.
export const GROUNDED_VERDICTS = {
  simplest: "no",
  architecture: "violates",
  debt: "introduces",
  hiddenRisks: "found",
};

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "verdict",
    "summary",
    "findings",
    "issueDrafts",
    "acCoverage",
    "headSha",
    "investigated",
    "judgment",
    "degraded",
  ],
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
        required: ["id", "path", "line", "severity", "finding", "suggestedComment", "escalate"],
        properties: {
          id: { type: "string", pattern: "^f\\d+$" },
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
    acCoverage: {
      type: ["array", "null"],
      maxItems: MAX_AC_COVERAGE,
      description:
        "Per-AC coverage of the goal this PR exists to meet (linked issues " +
        "first; the PR description's own checkbox list only as fallback). " +
        "Null when no usable ACs were found — the summary must say which " +
        "case: none recognizable anywhere, or present but not reliably " +
        "parseable. Always null when verdict is 'degraded'.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issueNumber", "criterion", "status", "evidence"],
        properties: {
          issueNumber: {
            type: ["number", "null"],
            description:
              "The linked issue the criterion came from; null = it came " +
              "from the PR description (fallback source).",
          },
          criterion: {
            type: "string",
            description: "The AC text — a discrete item quoted from the source, trimmed.",
          },
          status: {
            type: "string",
            enum: AC_COVERAGE_STATUSES,
            description:
              "addressed = the diff visibly implements it; not_in_diff = " +
              "nothing in THIS diff visibly addresses it (not a claim it is " +
              "unmet elsewhere); unclear = cannot tell from the diff alone.",
          },
          evidence: {
            type: "string",
            description:
              "One line: where in the diff (for addressed), or why " +
              "not/unclear. May be empty when the status phrase says it all.",
          },
        },
      },
    },
    headSha: {
      type: "string",
      description:
        "The PR head commit SHA, echoed VERBATIM from fetch_pr_diff's headSha " +
        "('' when the console did not send one). Never invented — it is the " +
        "stable key pairing this review with exactly the code it judged.",
    },
    investigated: {
      type: "array",
      maxItems: MAX_INVESTIGATED,
      description:
        "The investigation trail — one entry per context read (or per declared " +
        "skip of a mandatory check). Empty only when the diff needed no context " +
        "and the mandatory checks were all inapplicable (say why in summary).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "tool", "answer"],
        properties: {
          id: { type: "string", pattern: "^i\\d+$" },
          question: { type: "string", description: "What you asked, in plain language." },
          tool: { type: "string", enum: INVESTIGATION_TOOLS },
          answer: {
            type: "string",
            description:
              "One line: what the read showed — or 'skipped: <why>' / " +
              "'degraded: <reason>' for a check that did not complete.",
          },
        },
      },
    },
    judgment: {
      type: ["object", "null"],
      description:
        "The structured judgment over the change in the context of the " +
        "repository. Null exactly when verdict is 'degraded'. Negative " +
        "verdicts must cite investigated ids in basis — no investigation, no " +
        "claim; cannot_judge is honest and legitimate.",
      additionalProperties: false,
      required: ["simplest", "architecture", "debt", "hiddenRisks"],
      properties: Object.fromEntries(
        JUDGMENT_FIELDS.map((f) => [f, {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "note", "basis"],
          properties: {
            verdict: { type: "string", enum: JUDGMENT_VERDICTS[f] },
            note: { type: "string" },
            basis: { type: "array", maxItems: 5, items: { type: "string" } },
          },
        }]),
      ),
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
 * express the couplings: verdict<->findings/issueDrafts/degraded/
 * investigated/judgment, escalate<->issueDrafts count, grounded
 * verdict<->basis-cites-a-real-investigated-id). Returns { ok, errors }.
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

  const findingIds = new Set();
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
      if (typeof f.id !== "string" || !/^f\d+$/.test(f.id)) {
        push(`findings[${i}].id must match ^f\\d+$`);
      } else if (findingIds.has(f.id)) {
        push(`findings[${i}].id '${f.id}' is not unique`);
      } else {
        findingIds.add(f.id);
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

  if (review.acCoverage !== null) {
    if (!Array.isArray(review.acCoverage)) {
      push("acCoverage must be an array or null");
    } else {
      if (review.acCoverage.length > MAX_AC_COVERAGE) {
        push(`acCoverage must have at most ${MAX_AC_COVERAGE} entries`);
      }
      review.acCoverage.forEach((c, i) => {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          push(`acCoverage[${i}] must be an object`);
          return;
        }
        if (c.issueNumber !== null && typeof c.issueNumber !== "number") {
          push(`acCoverage[${i}].issueNumber must be a number or null`);
        }
        if (!isStr(c.criterion)) push(`acCoverage[${i}].criterion must be a non-empty string`);
        if (!AC_COVERAGE_STATUSES.includes(c.status)) {
          push(`acCoverage[${i}].status must be one of: ${AC_COVERAGE_STATUSES.join(", ")}`);
        }
        if (typeof c.evidence !== "string") {
          push(`acCoverage[${i}].evidence must be a string`);
        }
      });
    }
  }

  if (review.degraded !== null) {
    if (review.degraded === undefined || typeof review.degraded !== "object" || Array.isArray(review.degraded)) {
      push("degraded must be an object or null");
    } else if (!isStr(review.degraded.reason)) {
      push("degraded.reason must be a non-empty string when degraded is set");
    }
  }

  if (typeof review.headSha !== "string") push("headSha must be a string ('' when unknown)");

  const investigatedIds = new Set();
  if (!Array.isArray(review.investigated)) {
    push("investigated must be an array");
  } else {
    if (review.investigated.length > MAX_INVESTIGATED) {
      push(`investigated must have at most ${MAX_INVESTIGATED} entries`);
    }
    review.investigated.forEach((e, i) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) {
        push(`investigated[${i}] must be an object`);
        return;
      }
      if (typeof e.id !== "string" || !/^i\d+$/.test(e.id)) {
        push(`investigated[${i}].id must match ^i\\d+$`);
      } else if (investigatedIds.has(e.id)) {
        push(`investigated[${i}].id '${e.id}' is not unique`);
      } else {
        investigatedIds.add(e.id);
      }
      if (!isStr(e.question)) push(`investigated[${i}].question must be a non-empty string`);
      if (!INVESTIGATION_TOOLS.includes(e.tool)) {
        push(`investigated[${i}].tool must be one of: ${INVESTIGATION_TOOLS.join(", ")}`);
      }
      if (!isStr(e.answer)) push(`investigated[${i}].answer must be a non-empty string`);
    });
  }

  if (review.judgment !== null && review.judgment !== undefined) {
    if (typeof review.judgment !== "object" || Array.isArray(review.judgment)) {
      push("judgment must be an object or null");
    } else {
      for (const field of JUDGMENT_FIELDS) {
        const j = review.judgment[field];
        if (j === null || typeof j !== "object" || Array.isArray(j)) {
          push(`judgment.${field} must be an object`);
          continue;
        }
        if (!JUDGMENT_VERDICTS[field].includes(j.verdict)) {
          push(`judgment.${field}.verdict must be one of: ${JUDGMENT_VERDICTS[field].join(", ")}`);
        }
        if (typeof j.note !== "string") push(`judgment.${field}.note must be a string`);
        if (!Array.isArray(j.basis) || j.basis.length > 5 || !j.basis.every((b) => typeof b === "string")) {
          push(`judgment.${field}.basis must be an array of at most 5 strings`);
        } else if (j.verdict === GROUNDED_VERDICTS[field]) {
          if (!isStr(j.note)) push(`judgment.${field}: verdict '${j.verdict}' requires a non-empty note`);
          if (j.basis.length === 0) {
            push(`judgment.${field}: verdict '${j.verdict}' requires a non-empty basis — no investigation, no claim`);
          } else {
            for (const b of j.basis) {
              if (!investigatedIds.has(b)) {
                push(`judgment.${field}.basis references unknown investigated id '${b}'`);
              }
            }
          }
        }
      }
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
    if (review.acCoverage !== null && review.acCoverage !== undefined) {
      push("verdict 'degraded' must carry acCoverage: null — the diff was never read");
    }
    if (review.judgment !== null && review.judgment !== undefined) {
      push("verdict 'degraded' must carry judgment: null — the diff was never read");
    }
    if (Array.isArray(review.investigated) && review.investigated.length > 0) {
      push("investigated must be empty — the diff was never read");
    }
  } else {
    if (review.degraded !== null && review.degraded !== undefined) {
      push("degraded must be null unless verdict is 'degraded'");
    }
    if (review.judgment === null || review.judgment === undefined) {
      push("judgment must be an object unless verdict is 'degraded'");
    }
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
