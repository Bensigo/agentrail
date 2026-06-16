import { describe, it, expect, vi } from "vitest";

// The db module is mocked so importing the query module is side-effect free; the
// gate under test is pure and never touches it.
vi.mock("../db.js", () => ({ db: {} }));

import {
  validateAcceptanceCriteria,
  parseBlockedBy,
} from "../queries/github_intake.js";

/**
 * The TS AC gate must agree with the Python input-contract gate
 * (agentrail/afk/input_contract.py): an issue is admitted iff its
 * `Acceptance criteria` section contains at least one markdown checkbox.
 */
describe("validateAcceptanceCriteria", () => {
  it("admits a body with a checkbox under the Acceptance criteria heading", () => {
    const body = "## Acceptance criteria\n- [ ] the endpoint returns 200\n";
    const result = validateAcceptanceCriteria(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.criteria).toEqual(["the endpoint returns 200"]);
  });

  it("admits a checked checkbox too and collects all criteria in order", () => {
    const body =
      "## Acceptance Criteria\n- [x] first\n- [ ] second\n";
    const result = validateAcceptanceCriteria(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.criteria).toEqual(["first", "second"]);
  });

  it("rejects a body with no Acceptance criteria section", () => {
    const result = validateAcceptanceCriteria("## Summary\nMake it nice.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no 'Acceptance criteria' section/);
  });

  it("rejects an Acceptance criteria section with only prose (no checkboxes)", () => {
    const body = "## Acceptance criteria\nIt should feel fast and work well.\n";
    const result = validateAcceptanceCriteria(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not machine-checkable/);
  });

  it("does not count checkboxes outside the Acceptance criteria section", () => {
    // A task list under another heading is not acceptance criteria.
    const body =
      "## What to build\n- [ ] write the handler\n## Acceptance criteria\nprose only\n";
    const result = validateAcceptanceCriteria(body);
    expect(result.ok).toBe(false);
  });

  it("stops the section at the next heading", () => {
    const body =
      "## Acceptance criteria\n- [ ] real AC\n## Notes\n- [ ] not AC\n";
    const result = validateAcceptanceCriteria(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.criteria).toEqual(["real AC"]);
  });
});

describe("parseBlockedBy", () => {
  it("returns [] when there are no dependency declarations", () => {
    expect(parseBlockedBy("## Summary\njust a normal issue\n")).toEqual([]);
  });

  it("parses a single 'Blocked by #N'", () => {
    expect(parseBlockedBy("Blocked by #5\n")).toEqual([5]);
  });

  it("parses 'depends on', 'blocked-by:', and multiple refs, deduped + sorted", () => {
    expect(parseBlockedBy("Depends on #7 and #3\nblocked-by: #7, #9\n")).toEqual([
      3, 7, 9,
    ]);
  });

  it("only counts refs on the dependency line, not other #N mentions", () => {
    const body = "Fixes #99 in the handler.\nBlocked by #4\nsee #100 too\n";
    expect(parseBlockedBy(body)).toEqual([4]);
  });
});
