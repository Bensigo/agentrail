// Unit tests for the pure model-selection core (no SDK, no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseModel,
  GATEWAY_MODEL_ID,
  DEFAULT_COMPATIBLE_MODEL_ID,
  DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
} from "../agent/lib/model.core.mjs";

test("no base URL → production AI Gateway string id", () => {
  assert.deepEqual(chooseModel({}), {
    kind: "gateway",
    modelId: GATEWAY_MODEL_ID,
  });
});

test("whitespace-only base URL is treated as unset → gateway", () => {
  assert.deepEqual(chooseModel({ JACE_MODEL_BASE_URL: "   " }), {
    kind: "gateway",
    modelId: GATEWAY_MODEL_ID,
  });
});

test("base URL set, no model id → openai-compatible with default model, no apiKey", () => {
  const c = chooseModel({ JACE_MODEL_BASE_URL: "http://localhost:11434/v1" });
  assert.equal(c.kind, "openai-compatible");
  assert.equal(c.baseURL, "http://localhost:11434/v1");
  assert.equal(c.modelId, DEFAULT_COMPATIBLE_MODEL_ID);
  assert.equal(c.name, "jace-openai-compatible");
  assert.equal(c.contextWindowTokens, DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS);
  assert.equal("apiKey" in c, false);
});

test("base URL + model id + api key are all threaded through", () => {
  const c = chooseModel({
    JACE_MODEL_BASE_URL: "http://localhost:11434/v1",
    JACE_MODEL_ID: "gemma4:latest",
    JACE_MODEL_API_KEY: "sk-local",
  });
  assert.deepEqual(c, {
    kind: "openai-compatible",
    baseURL: "http://localhost:11434/v1",
    modelId: "gemma4:latest",
    contextWindowTokens: DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
    name: "jace-openai-compatible",
    apiKey: "sk-local",
  });
});

test("blank api key is omitted, not passed as empty", () => {
  const c = chooseModel({
    JACE_MODEL_BASE_URL: "http://localhost:11434/v1",
    JACE_MODEL_API_KEY: "  ",
  });
  assert.equal("apiKey" in c, false);
});

test("gateway path carries no context window (resolved from AI Gateway catalog)", () => {
  const c = chooseModel({});
  assert.equal("contextWindowTokens" in c, false);
});

test("explicit JACE_MODEL_CONTEXT_WINDOW_TOKENS is honored verbatim", () => {
  const c = chooseModel({
    JACE_MODEL_BASE_URL: "http://localhost:11434/v1",
    JACE_MODEL_CONTEXT_WINDOW_TOKENS: "32768",
  });
  assert.equal(c.contextWindowTokens, 32768);
});

test("invalid context window (non-numeric / zero / negative / blank) falls back to default", () => {
  for (const bad of ["", "  ", "not-a-number", "0", "-4096", "12.5abc", undefined]) {
    const c = chooseModel({
      JACE_MODEL_BASE_URL: "http://localhost:11434/v1",
      JACE_MODEL_CONTEXT_WINDOW_TOKENS: bad,
    });
    assert.equal(
      c.contextWindowTokens,
      DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS,
      `expected default for input ${JSON.stringify(bad)}`,
    );
  }
});
