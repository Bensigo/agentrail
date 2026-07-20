/**
 * AC3 (#1337): "An invalid slug in any shipped config fails CI against the
 * snapshot."
 *
 * This is the coupling test in the spirit of the historical invalid-
 * critic-slug bug referenced in `agentrail/tests/run/test_pricing.py`
 * (`test_hosted_config_template_models_all_price_nonzero`'s docstring): every
 * model slug this repo hardcodes anywhere — the hosted runner template AND
 * the alignment brief's 3-seat catalog — must resolve in the committed
 * OpenRouter snapshot. An unresolvable slug fails this test loudly, in CI,
 * not silently at $0 or as a gateway 404 discovered only when a real run
 * tries to use it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { isKnownModelSlug } from "./gateway-catalog";
import { MODEL_CATALOG } from "./catalog";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// apps/console/lib/alignment -> repo root -> deploy/runner/agentrail-config.hosted.json
const HOSTED_CONFIG_PATH = resolve(__dirname, "../../../../deploy/runner/agentrail-config.hosted.json");

// A slug that will never legitimately exist — the "deliberately-bad slug"
// case the task's verification checklist calls for.
const DEFINITELY_FAKE_SLUG = "not-a-real-provider/definitely-fake-model-9999";

interface HostedRunnerConfig {
  runners: {
    claude: {
      models: Record<string, string>;
    };
  };
}

function loadHostedConfig(): HostedRunnerConfig {
  return JSON.parse(readFileSync(HOSTED_CONFIG_PATH, "utf8")) as HostedRunnerConfig;
}

describe("AC3: shipped hosted-runner config slugs are all known to the gateway snapshot", () => {
  const config = loadHostedConfig();
  const seats = config.runners.claude.models;

  it("deploy/runner/agentrail-config.hosted.json carries the expected execute/verify/critic seats", () => {
    // Sanity check on the fixture itself — if this ever fails, the assertions
    // below are iterating over the wrong (or an empty) set of seats.
    expect(Object.keys(seats).sort()).toEqual(["critic", "execute", "verify"]);
  });

  it("every hosted-runner seat slug resolves in the gateway snapshot", () => {
    const unresolved = Object.entries(seats).filter(([, slug]) => !isKnownModelSlug(slug));
    expect(
      unresolved,
      `hosted config seat(s) not found in the OpenRouter snapshot: ${unresolved
        .map(([seat, slug]) => `${seat}="${slug}"`)
        .join(", ")} — either the slug is wrong/retired, or the snapshot needs ` +
        `\`pnpm --filter @agentrail/console catalog:refresh\``
    ).toEqual([]);
  });
});

describe("AC3: shipped alignment-brief catalog (catalog.ts MODEL_CATALOG) slugs are all known to the gateway snapshot", () => {
  it("every MODEL_CATALOG seat's slug resolves in the gateway snapshot", () => {
    const unresolved = Object.entries(MODEL_CATALOG).filter(([, seat]) => !isKnownModelSlug(seat.slug));
    expect(
      unresolved,
      `MODEL_CATALOG seat(s) not found in the OpenRouter snapshot: ${unresolved
        .map(([taskType, seat]) => `${taskType}="${seat.slug}"`)
        .join(", ")}`
    ).toEqual([]);
  });
});

describe("AC3 mechanism proof: a deliberately-bad slug actually fails this assertion style", () => {
  // NOTE: this deliberately does NOT reuse the real historical bad slug
  // ("~anthropic/claude-haiku-latest", named in test_pricing.py's docstring)
  // as its example — a live fetch during this task (2026-07-20) found that
  // exact id now present in OpenRouter's own `/api/v1/models` list (tilde-
  // prefixed "latest" aliases, e.g. `~x-ai/grok-latest`, are real `id`
  // values there today, whatever the case was when the original bug shipped).
  // Asserting that specific string is invalid would make this test either
  // wrong today or fragile against a future OpenRouter catalog change that
  // has nothing to do with this repo. A slug that can never legitimately
  // exist is the stable choice.
  it("a synthetic config with one invalid slug is caught by the same check used above", () => {
    const syntheticSeats: Record<string, string> = {
      execute: "anthropic/claude-sonnet-5", // real — should pass
      critic: DEFINITELY_FAKE_SLUG,
    };
    const unresolved = Object.entries(syntheticSeats).filter(([, slug]) => !isKnownModelSlug(slug));
    expect(unresolved).toEqual([["critic", DEFINITELY_FAKE_SLUG]]);
  });
});
