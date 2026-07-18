import { describe, it, expect } from "vitest";
import { classifyTaskType } from "./classifier";
import type { TaskInput, TaskType } from "./classifier";

function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    title: "",
    whatToBuild: "",
    acceptanceCriteria: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Table-driven: realistic titles across all four task types.
// ---------------------------------------------------------------------------
describe("classifyTaskType: realistic cases", () => {
  const cases: Array<{ name: string; given: TaskInput; expected: TaskType }> = [
    {
      name: "ui: new settings page with a responsive layout",
      given: input({
        title: "Add a settings page with a responsive layout",
        whatToBuild: "New settings page for account preferences",
        acceptanceCriteria: [
          "AC1: Layout adapts to mobile screens",
          "AC2: Uses the shared design system button styles",
        ],
      }),
      expected: "ui",
    },
    {
      name: "refactor: decouple billing from invoicing",
      given: input({
        title: "Refactor the billing pipeline to decouple invoicing from payments",
        acceptanceCriteria: ["AC1: Billing and invoicing are separate modules"],
      }),
      expected: "refactor",
    },
    {
      name: "refactor: migrate auth module",
      given: input({
        title: "Migrate the auth module to the new session store",
        acceptanceCriteria: ["AC1: Old session table has no remaining readers"],
      }),
      expected: "refactor",
    },
    {
      name: "mechanical: dependency bump",
      given: input({
        title: "Bump lodash to v5",
        acceptanceCriteria: ["AC1: package.json shows lodash ^5.0.0", "AC2: changelog updated"],
      }),
      expected: "mechanical",
    },
    {
      name: "mechanical: typo fix",
      given: input({
        title: "Fix typo in onboarding README",
        acceptanceCriteria: ["AC1: 'recieve' corrected to 'receive'"],
      }),
      expected: "mechanical",
    },
    {
      name: "ambiguous-defaults-to-general: no keyword hits anywhere",
      given: input({
        title: "Investigate intermittent CI timeout",
        whatToBuild: "Add retry logic to the flaky integration test runner",
        acceptanceCriteria: ["AC1: CI failure rate drops below 1%"],
      }),
      expected: "general",
    },
    {
      name: "ambiguous-defaults-to-general: plain maintenance ask",
      given: input({ title: "Update contributing guidelines" }),
      expected: "general",
    },
    {
      name: "word-boundary regression guard: 'ui' must not match inside 'build'",
      given: input({
        title: "Speed up the CI build pipeline",
        acceptanceCriteria: ["AC1: build completes in under 5 minutes"],
      }),
      expected: "general",
    },
    {
      name: "case-insensitivity: uppercase title still classifies correctly",
      given: input({
        title: "REFACTOR THE PAYMENT ENGINE",
        acceptanceCriteria: ["AC1: Payment logic lives in its own service"],
      }),
      expected: "refactor",
    },
  ];

  for (const { name, given, expected } of cases) {
    it(`${name} -> "${expected}"`, () => {
      expect(classifyTaskType(given)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Precedence: mechanical > refactor > ui > general (documented in classifier.ts).
// ---------------------------------------------------------------------------
describe("classifyTaskType: documented precedence when multiple sets match", () => {
  it("mechanical wins over ui ('bump' + 'component'/'button' both present)", () => {
    const result = classifyTaskType(
      input({
        title: "Bump the Button component's version",
        acceptanceCriteria: ["AC1: package.json version incremented"],
      })
    );
    expect(result).toBe("mechanical");
  });

  it("refactor wins over ui ('redesign' + 'modal'/'design' both present)", () => {
    const result = classifyTaskType(
      input({
        title: "Redesign the onboarding modal",
        acceptanceCriteria: ["AC1: Modal matches the new visual design"],
      })
    );
    expect(result).toBe("refactor");
  });
});

// ---------------------------------------------------------------------------
// Determinism: same input, same output, regardless of field the keyword sits in.
// ---------------------------------------------------------------------------
describe("classifyTaskType: determinism", () => {
  it("returns the identical result across repeated calls on the same input", () => {
    const given = input({ title: "Rename the legacy config module" });
    const first = classifyTaskType(given);
    const second = classifyTaskType(given);
    expect(first).toBe(second);
    expect(first).toBe("mechanical");
  });

  it("a keyword hit in acceptanceCriteria alone is enough to classify", () => {
    const result = classifyTaskType(
      input({
        title: "Investigate slow checkout",
        acceptanceCriteria: ["AC1: Refactor the checkout state machine"],
      })
    );
    expect(result).toBe("refactor");
  });
});
