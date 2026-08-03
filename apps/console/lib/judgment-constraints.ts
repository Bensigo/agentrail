type ConstraintMode = "off" | "warn" | "block";

export type JudgmentConstraintItem = {
  id: string;
  content: string;
  type?: string | null;
  source?: string | null;
  tags?: string[] | null;
};

export type JudgmentConstraintViolation = {
  kind: "decision" | "rejected_approach";
  id: string;
  reason: string;
  source: string;
};

const NEGATED_PATTERNS = [
  /\bdo not use\s+([a-z0-9][a-z0-9 ._/-]{1,80})/i,
  /\bdon't use\s+([a-z0-9][a-z0-9 ._/-]{1,80})/i,
  /\bmust not use\s+([a-z0-9][a-z0-9 ._/-]{1,80})/i,
  /\bnever use\s+([a-z0-9][a-z0-9 ._/-]{1,80})/i,
  /\brejected (?:approach|option|design)\s*:?\s*([a-z0-9][a-z0-9 ._/-]{1,120})/i,
];

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[`*_#()[\]{}:;,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractConstraintTargets(content: string): string[] {
  const targets: string[] = [];
  for (const pattern of NEGATED_PATTERNS) {
    const match = content.match(pattern);
    if (!match) continue;
    const target = normalizeText(match[1])
      .replace(/\b(?:for|because|since|when|unless|in favor of|instead of)\b.*$/i, "")
      .trim();
    if (target.length >= 2) targets.push(target);
  }
  return Array.from(new Set(targets));
}

function issueText(issue: Record<string, unknown>): string {
  const acceptanceCriteria = Array.isArray(issue.acceptanceCriteria)
    ? issue.acceptanceCriteria.join("\n")
    : "";
  return normalizeText([
    issue.title,
    issue.body,
    issue.requiredContext,
    issue.whatToBuild,
    acceptanceCriteria,
    issue.verification,
  ].join("\n"));
}

function itemKind(item: JudgmentConstraintItem): "decision" | "rejected_approach" {
  return item.tags?.includes("rejected_approach") ? "rejected_approach" : "decision";
}

export function evaluateJudgmentConstraints({
  mode,
  issue,
  items,
}: {
  mode: ConstraintMode;
  issue: Record<string, unknown>;
  items: JudgmentConstraintItem[];
}): { allow: boolean; mode: ConstraintMode; violations: JudgmentConstraintViolation[]; message?: string } {
  if (mode === "off") return { allow: true, mode, violations: [] };

  const text = issueText(issue);
  const violations: JudgmentConstraintViolation[] = [];
  for (const item of items) {
    const targets = extractConstraintTargets(item.content);
    const matched = targets.find((target) => text.includes(target));
    if (!matched) continue;
    const kind = itemKind(item);
    violations.push({
      kind,
      id: item.id,
      reason:
        kind === "rejected_approach"
          ? `Issue proposes a recorded rejected approach: ${matched}.`
          : `Issue appears to contradict a recorded decision: ${matched}.`,
      source: item.source ?? "memory_items",
    });
  }

  const allow = mode === "block" ? violations.length === 0 : true;
  const message =
    violations.length > 0
      ? `Recorded judgment constraints ${allow ? "warn on" : "block"} this issue.`
      : undefined;
  return { allow, mode, violations, ...(message ? { message } : {}) };
}

export function parseJudgmentConstraintsMode(value: unknown): ConstraintMode {
  const raw = String(value ?? "off").trim().toLowerCase();
  if (raw === "warn" || raw === "block") return raw;
  return "off";
}
