import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Import-direction guard (subscription-platform slice 2, Task 9).
//
// `lib/policy/` (billing: plans, entitlements — `plan-policies.ts`,
// `resolve-policy.ts`) is allowed to import FROM `lib/alignment/` (routing:
// task classification, model candidates) — both already do, for
// `QualityProfile` — but never the other way around: routing must not know
// billing exists. `quality-profile.ts`'s own module doc states the rule and
// why the shared `QualityProfile` type lives in `lib/alignment/` (a leaf
// module) rather than `lib/policy/` — that placement is exactly what makes a
// strictly one-directional import graph possible. This test is the
// mechanical enforcement: read every `lib/alignment/*.ts` file's own source
// text and assert none of its import specifiers resolve into `lib/policy/`.
//
// Deliberately reads raw source text with a regex rather than a TS
// compiler/AST API — the same "read the file, regex what matters" pattern
// `catalog.test.ts` already uses for its own cross-language drift guard (see
// that file's module doc) — dependency-free, fast, and keeps every alignment
// module free of any test-only introspection hooks.
//
// Only RELATIVE specifiers can possibly resolve into `lib/policy/` in this
// app: tsconfig.json's `@/*` path alias maps only to `./app/*` and
// `./src/*` (no `lib/*` mapping exists), so a bare/aliased import can never
// reach `lib/policy/` either — this guard only needs to resolve specifiers
// starting with `.`.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const ALIGNMENT_DIR = dirname(__filename); // apps/console/lib/alignment
const POLICY_DIR = resolve(ALIGNMENT_DIR, "../policy"); // apps/console/lib/policy

/**
 * Matches every import-specifier form this codebase's TS source uses:
 * `import x from "s"` / `import { x } from "s"` / `export { x } from "s"` /
 * `export * from "s"` (the shared `from "s"` suffix), bare side-effect
 * `import "s"`, and dynamic `import("s")`.
 */
const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map((match) => match[1]);
}

/** Every specifier, from a file in `fileDir`, that resolves inside `lib/policy/`. */
function policyViolations(fileDir: string, specifiers: string[]): string[] {
  return specifiers.filter((specifier) => {
    if (!specifier.startsWith(".")) return false; // package imports (e.g. "vitest") can never be lib/policy
    const resolved = resolve(fileDir, specifier);
    return resolved === POLICY_DIR || resolved.startsWith(`${POLICY_DIR}/`);
  });
}

const ALIGNMENT_SOURCE_FILES = readdirSync(ALIGNMENT_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => entry.name);

describe("lib/alignment/ never imports from lib/policy/ (routing must not know billing exists)", () => {
  // Canary: if the directory scan ever came back empty (e.g. a path typo
  // after a future refactor), every `it` below would vacuously pass instead
  // of failing loudly. This pins a sane lower bound so that failure mode is
  // itself caught.
  it("found alignment source files to check", () => {
    expect(ALIGNMENT_SOURCE_FILES.length).toBeGreaterThan(5);
  });

  for (const file of ALIGNMENT_SOURCE_FILES) {
    it(`${file} has no import specifier resolving into lib/policy/`, () => {
      const source = readFileSync(join(ALIGNMENT_DIR, file), "utf8");
      const violations = policyViolations(ALIGNMENT_DIR, importSpecifiersOf(source));
      expect(violations, `${file} imports from lib/policy/: ${violations.join(", ")}`).toEqual([]);
    });
  }
});
