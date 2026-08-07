export type AcceptanceCriterion = {
  id: string;
  text: string;
  required: boolean;
  /** Requires criterion-specific runtime evidence when a safe environment exists. */
  userVisible: boolean;
};

export type AcceptanceQuestion = {
  id: string;
  text: string;
  status: "open" | "resolved";
  resolution?: string;
};

export type AcceptanceContract = {
  originalUserWording: string;
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  nonGoals: string[];
  risks: string[];
  environmentExpectations: string[];
  stopConditions: string[];
  affectedCodebaseUnits: string[];
  openQuestions: AcceptanceQuestion[];
};

export type ParseAcceptanceContractResult =
  | { ok: true; value: AcceptanceContract }
  | { ok: false; errors: Record<string, string> };

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown, key: string, errors: Record<string, string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !text(item))) {
    errors[key] = `${key} must be an array of non-empty strings`;
    return [];
  }
  return value.map((item) => (item as string).trim());
}

/**
 * The shared boundary for accepted objectives. Deliberately small and stable:
 * a user may leave a field empty, but Jace cannot hide it or invent an ID.
 */
export function parseAcceptanceContract(value: unknown): ParseAcceptanceContractResult {
  if (!object(value)) return { ok: false, errors: { contract: "contract must be an object" } };
  const errors: Record<string, string> = {};
  const originalUserWording = text(value.originalUserWording);
  const goal = text(value.goal);
  if (!originalUserWording) errors.originalUserWording = "originalUserWording is required";
  if (!goal) errors.goal = "goal is required";

  const acceptanceCriteria: AcceptanceCriterion[] = [];
  if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length === 0) {
    errors.acceptanceCriteria = "at least one acceptance criterion is required";
  } else {
    const ids = new Set<string>();
    for (const [index, item] of value.acceptanceCriteria.entries()) {
      if (!object(item) || !text(item.id) || !text(item.text)) {
        errors[`acceptanceCriteria.${index}`] = "criterion requires a non-empty id and text";
        continue;
      }
      const id = text(item.id)!;
      if (ids.has(id)) {
        errors[`acceptanceCriteria.${index}.id`] = "criterion ids must be unique";
        continue;
      }
      ids.add(id);
      if (item.required !== undefined && typeof item.required !== "boolean") {
        errors[`acceptanceCriteria.${index}.required`] = "required must be boolean";
        continue;
      }
      if (item.userVisible !== undefined && typeof item.userVisible !== "boolean") {
        errors[`acceptanceCriteria.${index}.userVisible`] = "userVisible must be boolean";
        continue;
      }
      acceptanceCriteria.push({
        id,
        text: text(item.text)!,
        required: item.required !== false,
        userVisible: item.userVisible === true,
      });
    }
  }

  const openQuestions: AcceptanceQuestion[] = [];
  if (value.openQuestions !== undefined) {
    if (!Array.isArray(value.openQuestions)) {
      errors.openQuestions = "openQuestions must be an array";
    } else {
      for (const [index, item] of value.openQuestions.entries()) {
        if (!object(item) || !text(item.id) || !text(item.text) || (item.status !== "open" && item.status !== "resolved")) {
          errors[`openQuestions.${index}`] = "question requires id, text, and open or resolved status";
          continue;
        }
        const resolution = item.resolution === undefined ? undefined : text(item.resolution);
        if (item.status === "resolved" && !resolution) {
          errors[`openQuestions.${index}.resolution`] = "resolved question requires a resolution";
          continue;
        }
        openQuestions.push({ id: text(item.id)!, text: text(item.text)!, status: item.status, ...(resolution ? { resolution } : {}) });
      }
    }
  }

  const result = {
    originalUserWording: originalUserWording ?? "",
    goal: goal ?? "",
    acceptanceCriteria,
    nonGoals: strings(value.nonGoals, "nonGoals", errors),
    risks: strings(value.risks, "risks", errors),
    environmentExpectations: strings(value.environmentExpectations, "environmentExpectations", errors),
    stopConditions: strings(value.stopConditions, "stopConditions", errors),
    affectedCodebaseUnits: strings(value.affectedCodebaseUnits, "affectedCodebaseUnits", errors),
    openQuestions,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: result };
}
