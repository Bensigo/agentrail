// Human-readable explanations for agent run failures.
//
// The raw failure record carries a `failure_type`, a `message`, and an
// `evidence` blob — none of which tell a human *what it means* or *why it
// happened*. This module maps each known failure type to a plain-English
// explanation: what broke, the usual causes, and what to check next. It is a
// deterministic knowledge map (no LLM call) so the page renders instantly and
// the same failure always reads the same way.

export interface FailureExplanation {
  /** Short human title, e.g. "Tests failed". */
  title: string;
  /** One-line plain-English summary of what happened. */
  summary: string;
  /** The usual reasons this failure occurs, most likely first. */
  why: string[];
  /** Concrete next steps to confirm the cause and move toward a fix. */
  whatToCheck: string[];
  /** Human category label shown as a chip, e.g. "Verification". */
  category: string;
}

export interface SeverityMeaning {
  /** Normalized severity bucket. */
  level: "critical" | "high" | "medium" | "low";
  /** What this severity implies for the run and the user. */
  impact: string;
}

interface FailureInput {
  failure_type: string;
  message: string;
  normalized_error?: string;
  phase?: string;
}

// Known failure types → explanation template. Keep the language concrete and
// blame-free; the reader wants to act, not to be lectured.
const EXPLANATIONS: Record<string, FailureExplanation> = {
  tool_error: {
    title: "A tool call failed",
    summary:
      "The agent invoked a tool (a shell command, file edit, or API call) and the tool returned an error instead of a result.",
    category: "Tooling",
    why: [
      "The command or arguments were malformed, or referenced a path that does not exist.",
      "A required binary or dependency was missing from the run environment.",
      "The tool hit a permission boundary (sandbox, file mode, or denied capability).",
    ],
    whatToCheck: [
      "Read the evidence below for the exact command and its stderr.",
      "Confirm the referenced file or binary exists in the repo and the run image.",
      "If it is a permissions issue, widen the allowlist or run the step outside the sandbox.",
    ],
  },
  context_error: {
    title: "Context retrieval failed",
    summary:
      "The agent could not assemble the context it needed — retrieval, indexing, or the context pack step errored.",
    category: "Context",
    why: [
      "The repository index is missing, stale, or was never built for this commit.",
      "A retrieval query exceeded its budget or hit a custody/redaction policy.",
      "The context store (ClickHouse / index files) was briefly unavailable.",
    ],
    whatToCheck: [
      "Confirm the index snapshot for this repo and commit exists.",
      "Re-run the index build, then retry the run.",
      "Check the Context section of the run for denied or stale sources.",
    ],
  },
  auth_error: {
    title: "Authentication failed",
    summary:
      "A credential the run depended on was missing, expired, or rejected by the upstream service.",
    category: "Auth",
    why: [
      "An API key or OAuth token expired or was revoked.",
      "The token lacks the scope the operation requires (e.g. `repo` for GitHub).",
      "An environment variable holding the secret was not set in this run.",
    ],
    whatToCheck: [
      "Re-link the affected connector or rotate the API key.",
      "Confirm the token carries the required scopes, then retry.",
      "Verify the secret is present in the run's environment.",
    ],
  },
  lint_error: {
    title: "Lint checks failed",
    summary:
      "The agent's changes did not pass the project's linter or formatter, so the verification gate blocked the run.",
    category: "Verification",
    why: [
      "The generated code violates a style or static-analysis rule.",
      "An import is unused, a type is wrong, or a formatter rewrite is pending.",
      "The lint config changed and existing code no longer conforms.",
    ],
    whatToCheck: [
      "Read the evidence for the specific rule and file:line.",
      "Run the linter locally on the branch to reproduce.",
      "Decide whether to fix the code or adjust the rule.",
    ],
  },
  test_error: {
    title: "Tests failed",
    summary:
      "One or more tests failed when the agent ran the suite, so the change was not verified as correct.",
    category: "Verification",
    why: [
      "The change introduced a regression or broke an existing assertion.",
      "A new test the agent wrote is itself wrong, or hangs on an unmocked dependency.",
      "The test environment is missing a service, fixture, or env var the suite needs.",
    ],
    whatToCheck: [
      "Read the evidence for the failing test name and assertion.",
      "Reproduce locally; confirm whether the test or the code is wrong.",
      "Check for unmocked subprocess/network calls if a test hung.",
    ],
  },
  build_error: {
    title: "Build failed",
    summary:
      "The project failed to compile or bundle after the agent's changes, so nothing downstream could run.",
    category: "Build",
    why: [
      "A type error, syntax error, or missing import broke compilation.",
      "A dependency version mismatch or a stale build artifact (dist/) is in play.",
      "A generated file references a symbol that does not exist.",
    ],
    whatToCheck: [
      "Read the evidence for the first compiler error — later errors often cascade.",
      "Rebuild the affected package; check for stale gitignored dist/.",
      "Confirm the referenced symbols and imports resolve.",
    ],
  },
  afk_failure: {
    title: "Autonomous run was abandoned",
    summary:
      "An AFK (away-from-keyboard) run stopped before completing — its own verify or review gate failed, or it exhausted its attempts.",
    category: "Orchestration",
    why: [
      "The agent's verification step failed repeatedly and the run was sent to human review.",
      "A generated test hung on an unmocked subprocess or agent call and timed out.",
      "The task was under-specified, so the agent could not converge on a passing change.",
    ],
    whatToCheck: [
      "Read the reason in the evidence — it names which gate failed.",
      "Open the PR (if one was raised) and review the blocking findings.",
      "Tighten the issue's acceptance criteria before re-queuing.",
    ],
  },
};

// Generic fallback for unknown / future failure types. Still useful: it leans
// on the message so the reader gets something concrete rather than boilerplate.
function fallbackExplanation(input: FailureInput): FailureExplanation {
  const phase = input.phase?.trim();
  return {
    title: humanizeType(input.failure_type),
    summary: input.message
      ? `The run reported a "${humanizeType(input.failure_type)}" while in the ${phase || "run"} phase.`
      : `The run reported a "${humanizeType(input.failure_type)}".`,
    category: phase ? capitalize(phase) : "Run",
    why: [
      "This failure type does not have a curated explanation yet — read the message and evidence below for specifics.",
    ],
    whatToCheck: [
      "Read the message and evidence for the concrete error.",
      "Reproduce the step locally to confirm the cause.",
    ],
  };
}

/** Turn `tool_error` into `Tool error`. */
export function humanizeType(failureType: string): string {
  if (!failureType) return "Failure";
  const spaced = failureType.replace(/[_-]+/g, " ").trim();
  return capitalize(spaced);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve a failure record into a plain-English explanation. Always returns a
 * usable result — known types get a curated entry, everything else gets a
 * message-aware fallback.
 */
export function explainFailure(input: FailureInput): FailureExplanation {
  const known = EXPLANATIONS[input.failure_type];
  if (known) return known;
  return fallbackExplanation(input);
}

// Map the many severity spellings the pipeline emits (the runner defaults to
// the literal "error"; reviews emit critical/high/medium/low) onto four buckets
// with a human impact statement.
const SEVERITY_IMPACT: Record<SeverityMeaning["level"], string> = {
  critical:
    "Blocks the run entirely and usually needs a person. Nothing downstream can proceed until it is resolved.",
  high: "Failed the run or a required gate. The change is not safe to ship until this is addressed.",
  medium: "Degraded the run or tripped a non-blocking check. Worth fixing, but the run may have continued.",
  low: "Minor or advisory. Safe to note and move on, or fold into a follow-up.",
};

export function severityMeaning(rawSeverity: string): SeverityMeaning {
  const level = normalizeSeverity(rawSeverity);
  return { level, impact: SEVERITY_IMPACT[level] };
}

export function normalizeSeverity(raw: string): SeverityMeaning["level"] {
  const s = (raw || "").toLowerCase().trim();
  if (s === "critical" || s === "fatal" || s === "blocker") return "critical";
  if (s === "high" || s === "error" || s === "major") return "high";
  if (s === "medium" || s === "warn" || s === "warning" || s === "minor")
    return "medium";
  if (s === "low" || s === "info" || s === "notice" || s === "advisory")
    return "low";
  // Unknown spellings: treat as high so we never under-state a real failure.
  return "high";
}
