import { generateObject } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { chooseModel } from "./model.core.mjs";

const evidenceRef = z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int(), detail: z.string(), headSha: z.string() });
const criterion = z.object({ criterionId: z.string(), status: z.enum(["proven", "failed", "not_proven", "not_testable"]), observedBehavior: z.string(), expectedBehavior: z.string(), reason: z.string(), evidenceRefs: z.array(evidenceRef), runtimeEvidence: z.array(z.record(z.string(), z.unknown())).optional() });
const finding = z.object({ basis: z.enum(["acceptance_contract", "architecture_boundary", "repository_convention", "risk"]), criterionId: z.string().optional(), enforcedRuleId: z.string().optional(), ruleOrBoundary: z.string(), concreteImpact: z.string(), requiredCorrection: z.string(), reverification: z.string(), repairPath: z.string().optional(), evidenceRefs: z.array(evidenceRef) });
const schema = z.object({ overallStatus: z.enum(["proven", "failed", "not_proven", "not_testable"]), criteria: z.array(criterion), findings: z.array(finding), staticFindings: z.array(z.record(z.string(), z.unknown())).optional(), testResults: z.array(z.record(z.string(), z.unknown())).optional() });

function resolveModel(env) {
  const choice = chooseModel(env);
  return choice.kind === "gateway" ? choice.modelId : createOpenAICompatible({ name: choice.name, baseURL: choice.baseURL, ...(choice.apiKey ? { apiKey: choice.apiKey } : {}) })(choice.modelId);
}

/** Real structured evaluator adapter; all generated output is still revalidated downstream. */
export function createAcceptanceReviewModelGenerate({ env = process.env, generateObjectFn = generateObject, model = resolveModel(env) } = {}) {
  return async (input) => {
    const result = await generateObjectFn({
      model,
      schema,
      prompt: `${input.instruction}\n\nAcceptance Contract:\n${JSON.stringify(input.contract)}\n\nExact PR:\n${JSON.stringify(input.pr)}\n\nBounded exact-head diff:\n${input.diff}`,
      temperature: 0,
    });
    return result.object;
  };
}
