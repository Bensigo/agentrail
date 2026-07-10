// The researcher's structured output contract — the "brief".
//
// BRIEF_SCHEMA is a plain JSON Schema object handed to Eve as the researcher
// agent's `outputSchema`, so the child runs in task mode and the framework
// forces the model's final answer to match this shape (AC1). Keeping it as a
// dependency-free `.mjs` means it is importable by both agent.ts and node
// --test specs with no build and no SDK.
//
// The shape encodes the RAG protocol's "Return" step: a recommended approach,
// alternatives with why-not, citations that tie each external-tech claim to a
// URL and version, open questions, a confidence level, and the degraded-mode
// flag + which sources were actually reachable (AC5).

export const CONFIDENCE_LEVELS = ["high", "medium", "low"];
export const SOURCE_KINDS = ["context7", "web"];

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "recommendedApproach",
    "alternatives",
    "citations",
    "openQuestions",
    "confidence",
    "degraded",
    "sourcesUsed",
  ],
  properties: {
    recommendedApproach: {
      type: "string",
      minLength: 1,
      description:
        "The recommended way to use the external tech, grounded in the citations below.",
    },
    alternatives: {
      type: "array",
      description: "Candidate approaches that were considered and rejected.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["approach", "whyNot"],
        properties: {
          approach: { type: "string", minLength: 1 },
          whyNot: {
            type: "string",
            minLength: 1,
            description: "Why this alternative was not recommended.",
          },
        },
      },
    },
    citations: {
      type: "array",
      description:
        "Every external-tech claim traced to its source: claim -> URL -> version.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "url"],
        properties: {
          claim: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          version: {
            type: "string",
            description:
              "Library/SDK/API version the claim was verified against, when known.",
          },
        },
      },
    },
    openQuestions: {
      type: "array",
      description: "What remains unverified or ambiguous after research.",
      items: { type: "string", minLength: 1 },
    },
    confidence: {
      type: "string",
      enum: CONFIDENCE_LEVELS,
      description:
        "Overall confidence in the recommendation given the sources reached.",
    },
    degraded: {
      type: "boolean",
      description:
        "True when research ran without the live-web (Playwright) source — Context7-only.",
    },
    sourcesUsed: {
      type: "array",
      description: "Which research sources were actually reachable and used.",
      items: { type: "string", enum: SOURCE_KINDS },
    },
  },
};

/**
 * Minimal, dependency-free validator for a researcher brief. This is NOT a
 * general JSON Schema engine — it checks exactly the invariants BRIEF_SCHEMA
 * declares (required keys, primitive types, enums, nested array-item shapes) so
 * tests can assert both a well-formed brief and a degraded-mode brief validate,
 * and a malformed one does not. Returns { ok, errors }.
 */
export function validateBrief(brief) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (brief === null || typeof brief !== "object" || Array.isArray(brief)) {
    return { ok: false, errors: ["brief must be an object"] };
  }

  const isStr = (v) => typeof v === "string" && v.length > 0;

  if (!isStr(brief.recommendedApproach)) {
    push("recommendedApproach must be a non-empty string");
  }

  if (!Array.isArray(brief.alternatives)) {
    push("alternatives must be an array");
  } else {
    brief.alternatives.forEach((a, i) => {
      if (a === null || typeof a !== "object" || Array.isArray(a)) {
        push(`alternatives[${i}] must be an object`);
        return;
      }
      if (!isStr(a.approach)) push(`alternatives[${i}].approach must be a non-empty string`);
      if (!isStr(a.whyNot)) push(`alternatives[${i}].whyNot must be a non-empty string`);
    });
  }

  if (!Array.isArray(brief.citations)) {
    push("citations must be an array");
  } else {
    brief.citations.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        push(`citations[${i}] must be an object`);
        return;
      }
      if (!isStr(c.claim)) push(`citations[${i}].claim must be a non-empty string`);
      if (!isStr(c.url)) push(`citations[${i}].url must be a non-empty string`);
      if ("version" in c && typeof c.version !== "string") {
        push(`citations[${i}].version must be a string when present`);
      }
    });
  }

  if (!Array.isArray(brief.openQuestions)) {
    push("openQuestions must be an array");
  } else if (!brief.openQuestions.every(isStr)) {
    push("openQuestions must be an array of non-empty strings");
  }

  if (!CONFIDENCE_LEVELS.includes(brief.confidence)) {
    push(`confidence must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
  }

  if (typeof brief.degraded !== "boolean") {
    push("degraded must be a boolean");
  }

  if (!Array.isArray(brief.sourcesUsed)) {
    push("sourcesUsed must be an array");
  } else if (!brief.sourcesUsed.every((s) => SOURCE_KINDS.includes(s))) {
    push(`sourcesUsed items must each be one of ${SOURCE_KINDS.join(", ")}`);
  }

  return { ok: errors.length === 0, errors };
}
