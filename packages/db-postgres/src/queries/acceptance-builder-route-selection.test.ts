import { describe, expect, it } from "vitest";
import {
  parseAcceptanceBuilderRouteSelection,
  validateAcceptanceBuilderRouteSelection,
} from "./change_records.js";

const routeId = "00000000-0000-4000-8000-000000000123";

describe("Acceptance Builder route selection", () => {
  it("accepts only a registered-route UUID reference", () => {
    const selection = { routeId };
    expect(validateAcceptanceBuilderRouteSelection(selection)).toBe(true);
    expect(parseAcceptanceBuilderRouteSelection(selection)).toEqual(selection);
  });

  it.each([
    null,
    {},
    { routeId, adapter: "github_codex" },
    { routeId: "github_codex" },
    { routeId: "00000000-0000-0000-0000-000000000123" },
    { routeId: "github_pat_secret" },
    { routeId: [routeId] },
  ])("fails closed for malformed or widened selection data", (selection) => {
    expect(validateAcceptanceBuilderRouteSelection(selection)).toBe(false);
    expect(parseAcceptanceBuilderRouteSelection(selection)).toBeNull();
  });
});
