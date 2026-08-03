/**
 * Requirement-level intake decision for an alignment brief.
 *
 * This is deliberately conservative. It refuses only when the brief declares
 * a concrete contract problem that the existing alignment/evidence seams can
 * explain to a human. It does not pretend to know a probability of success:
 * confidence is an explicit `unknown` state until measured task-family
 * outcomes and runtime evidence are available.
 */

import type { TaskType } from "./classifier";

export type RequirementRefusalCode =
  | "conflicting_acceptance_criteria"
  | "unresolved_blocking_question"
  | "unsupported_environment"
  | "excessive_scope"
  | "missing_proof_path"
  | "unavailable_evidence";

export type RequirementTaskFamily = TaskType | "unknown";

export interface DecisionConfidence {
  state: "unknown";
  basis: string[];
}

export interface RequirementRefusal {
  code: RequirementRefusalCode;
  /** Short, stable label for console/chat surfaces and later reporting. */
  label: string;
  /** The claim Jace cannot establish from the current brief. */
  cannotEstablish: string;
  /** The smallest change that would make the request tractable. */
  requiredToProceed: string;
  taskFamily: RequirementTaskFamily;
  confidence: DecisionConfidence;
}

export type RequirementDecision =
  | {
      decision: "accept";
      taskFamily: RequirementTaskFamily;
      confidence: DecisionConfidence;
    }
  | {
      decision: "refuse";
      taskFamily: RequirementTaskFamily;
      confidence: DecisionConfidence;
      refusal: RequirementRefusal;
    };

export interface RequirementDecisionInput {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  /** The existing alignment classifier result, when the caller has one. */
  taskFamily?: RequirementTaskFamily;
}

const REFUSAL_COPY: Record<
  RequirementRefusalCode,
  Pick<RequirementRefusal, "label" | "cannotEstablish" | "requiredToProceed">
> = {
  conflicting_acceptance_criteria: {
    label: "Conflicting acceptance criteria",
    cannotEstablish: "the brief can be satisfied without violating another acceptance criterion",
    requiredToProceed: "remove the contradiction and state which behavior wins",
  },
  unresolved_blocking_question: {
    label: "Unresolved blocking question",
    cannotEstablish: "the implementation target is settled because the brief still contains an unanswered decision",
    requiredToProceed: "answer the blocking question in the brief before approving the work",
  },
  unsupported_environment: {
    label: "Unsupported environment",
    cannotEstablish: "the requested environment is available to the execution and verification path",
    requiredToProceed: "name a supported environment or add the missing environment capability",
  },
  excessive_scope: {
    label: "Excessive scope",
    cannotEstablish: "the work has a bounded change surface that one approved run can finish",
    requiredToProceed: "split the request into smaller, independently verifiable changes",
  },
  missing_proof_path: {
    label: "Missing proof path",
    cannotEstablish: "the acceptance criteria can be checked by a test, build, lint, or other declared verification",
    requiredToProceed: "add a concrete verification command or explain the observable evidence that will prove the criteria",
  },
  unavailable_evidence: {
    label: "Unavailable evidence",
    cannotEstablish: "the evidence required by the acceptance criteria is accessible to the run",
    requiredToProceed: "provide the required logs, fixtures, permissions, or other evidence source",
  },
};

const REFUSAL_ORDER: readonly RequirementRefusalCode[] = [
  "conflicting_acceptance_criteria",
  "unresolved_blocking_question",
  "unsupported_environment",
  "excessive_scope",
  "missing_proof_path",
  "unavailable_evidence",
];

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hasExplicitSignal(haystack: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(haystack));
}

function hasConflictingCriteria(criteria: string[]): boolean {
  const positive = /\b(must|should|required to|needs to)\b.*\b(enable|allow|include|keep|retain|support|preserve)\b/i;
  const negative = /\b(must|should|required to|needs to)\b.*\b(disable|forbid|exclude|remove|drop|not support|reject)\b/i;
  const positiveSubjects = criteria
    .filter((criterion) => positive.test(criterion))
    .map((criterion) => normalized(criterion).split(" ").filter((word) => word.length > 3));

  return criteria.some((criterion) => {
    if (!negative.test(criterion)) return false;
    const negativeWords = new Set(normalized(criterion).split(" "));
    return positiveSubjects.some((words) => words.some((word) => negativeWords.has(word)));
  });
}

function codeFor(input: RequirementDecisionInput): RequirementRefusalCode | null {
  const body = input.body || "";
  const criteria = input.acceptanceCriteria || [];
  const haystack = [input.title, body, ...criteria].join(" ");

  if (hasConflictingCriteria(criteria)) return "conflicting_acceptance_criteria";
  if (
    hasExplicitSignal(haystack, [
      /\b(open|blocking|unresolved) questions?\b/i,
      /\b(tbd|todo|needs? a decision|decision pending)\b/i,
    ]) || criteria.some((criterion) => /\?\s*$/.test(criterion.trim()))
  ) {
    return "unresolved_blocking_question";
  }
  if (
    hasExplicitSignal(haystack, [
      /\bunsupported environment\b/i,
      /\benvironment\b.{0,50}\b(not supported|unavailable)\b/i,
      /\b(not supported|unsupported)\b.{0,40}\b(ios|android|windows|macos|linux|browser)\b/i,
    ])
  ) {
    return "unsupported_environment";
  }
  if (
    criteria.length > 12 ||
    hasExplicitSignal(haystack, [
      /\bunbounded\b/i,
      /\brewrite (the )?(entire|whole)\b/i,
      /\b(entire codebase|all repositories|every service|everything)\b/i,
      /\bno (scope|limit)\b/i,
    ])
  ) {
    return "excessive_scope";
  }
  if (
    hasExplicitSignal(haystack, [
      /\b(no|without|cannot|can't)\s+(tests?|verification|proof|way to verify)\b/i,
      /\b(skip|skipping)\s+(tests?|verification)\b/i,
      /\buntestable\b/i,
    ])
  ) {
    return "missing_proof_path";
  }
  if (
    hasExplicitSignal(haystack, [
      /\bevidence (is|remains) unavailable\b/i,
      /\b(production|application)\s+(logs?|data)\s+(is|are)\s+unavailable\b/i,
      /\b(no|without) access to (the )?(logs?|fixtures?|production|data|permissions?)\b/i,
      /\bmissing (logs?|fixtures?|production data)\b/i,
    ])
  ) {
    return "unavailable_evidence";
  }
  return null;
}

function confidenceFor(taskFamily: RequirementTaskFamily, observedSignals: string[]): DecisionConfidence {
  return {
    state: "unknown",
    basis: [
      taskFamily === "unknown"
        ? "Task family: unknown"
        : `Task family: ${taskFamily}`,
      ...observedSignals,
    ],
  };
}

function observedSignal(code: RequirementRefusalCode): string {
  return `Evidence basis: the brief matched the explicit ${code} intake signal`;
}

/**
 * Decide whether a brief is tractable enough to present for approval.
 *
 * The function returns the first refusal in a stable order. This keeps a
 * single approval message actionable instead of presenting a noisy list of
 * speculative model judgments; later reporting can still count the primary
 * reason consistently.
 */
export function decideRequirementContract(input: RequirementDecisionInput): RequirementDecision {
  const taskFamily = input.taskFamily ?? "unknown";
  const code = codeFor(input);
  if (code === null) {
    return {
      decision: "accept",
      taskFamily,
      confidence: confidenceFor(taskFamily, [
        "Evidence basis: no explicit refusal signal was found in the brief",
      ]),
    };
  }

  const copy = REFUSAL_COPY[code];
  const confidence = confidenceFor(taskFamily, [observedSignal(code)]);
  return {
    decision: "refuse",
    taskFamily,
    confidence,
    refusal: {
      code,
      ...copy,
      taskFamily,
      confidence,
    },
  };
}

/** Stable labels for reports and defensive renderers. */
export function refusalLabel(code: RequirementRefusalCode): string {
  return REFUSAL_COPY[code]?.label ?? code;
}

/** Exported for report consumers that need the canonical reason order. */
export const REQUIREMENT_REFUSAL_CODES = REFUSAL_ORDER;
