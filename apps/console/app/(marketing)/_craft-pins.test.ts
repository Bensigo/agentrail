import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Mechanical craft pins for the #1279 landing redo (owner-rejection redo —
// see docs/superpowers/plans, TASTE.md's Typography/Color System). These
// guard the exact failure mode the owner flagged: styling that quietly
// drifts back to ad-hoc sizes, banned weights, or an accent system that
// goes unused. They do NOT check visual rhythm or copy quality (that's the
// slop-finder skill's job at review time) — just the mechanical rules that
// are cheap to keep honest in CI.
//
// Same lightweight raw-source-text convention as
// `_conversation-demo.tokens-only.test.ts` (no DOM/render harness in this
// repo) — read the file as text, regex against it.

const STYLED_FILES = ["page.tsx", "_conversation-demo.tsx"] as const;

function readSibling(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url), "utf8");
}

// Banned Tailwind weight utilities — TASTE.md's Typography section: "Font
// weights: Regular (400) for body/data, Bold (700) for headings and
// emphasis. No thin or black weights." In practice this repo only ever
// reached for extrabold/semibold/medium, never the thin/black end, so those
// are the three that matter to pin.
const BANNED_WEIGHT = /font-extrabold|font-semibold|font-medium/;

// An ad-hoc Tailwind arbitrary font-SIZE value: `text-[13px]`, `text-[1.2rem]`,
// `text-[clamp(...)]`. Deliberately excludes `text-[var(--...)]` — that
// bracket form carries a COLOR token, not a size, and is the correct way to
// apply a text color from the palette (e.g. `text-[var(--gray-10)]`).
// Mirrors `_conversation-demo.tokens-only.test.ts`'s own note on why its hex
// regex is scoped the way it is: target the real failure mode, not every
// bracket.
const AD_HOC_TEXT_SIZE = /text-\[(?!var\()[^\]]*\]/;

describe("(marketing) craft pins — weights", () => {
  it.each(STYLED_FILES)("%s uses only default (400) or font-bold (700) weight — no extrabold/semibold/medium", (file) => {
    const source = readSibling(file);
    expect(source.match(BANNED_WEIGHT)).toBeNull();
  });
});

describe("(marketing) craft pins — type scale (no ad-hoc sizes)", () => {
  it.each(STYLED_FILES)("%s has zero ad-hoc text-[..px/rem/clamp] font sizes", (file) => {
    const source = readSibling(file);
    expect(source.match(AD_HOC_TEXT_SIZE)).toBeNull();
  });

  it("page.tsx headings use the TASTE.md scale classes, not one-off sizes", () => {
    const source = readSibling("page.tsx");
    expect(source).toMatch(/text-heading-1/);
    expect(source).toMatch(/text-heading-2/);
  });
});

describe("(marketing) craft pins — accent system", () => {
  it("amber accent (--brand-accent / --yellow-11) is used as a real accent, not just defined", () => {
    const source = readSibling("page.tsx");
    // More than the two `LIGHT_SURFACE` custom-property *definitions* —
    // i.e. it's actually applied somewhere (step markers, links, dots, logo).
    const usages = source.match(/var\(--brand-accent\)/g) ?? [];
    expect(usages.length).toBeGreaterThan(2);
  });

  it("lemon fill (--yellow-09) is used with dark text (--gray-13) — the fill-with-dark-text rule", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).toMatch(/bg-\[var\(--yellow-09\)\]/);
      expect(source).toMatch(/text-\[var\(--gray-13\)\]/);
    }
  });

  it("no bg-[var(--brand-accent)] + text-white pairing remains (the old low-contrast button)", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).not.toMatch(/bg-\[var\(--brand-accent\)\][^"]*text-white/);
    }
  });
});

describe("(marketing) craft pins — mono on data moments", () => {
  // Windowed proximity check rather than an exact-line-count regex: JSX
  // formatting (an extra `>` on its own line, etc.) shouldn't make this
  // test brittle. Asserts a mono class (`font-mono` or `text-mono-data`)
  // appears somewhere in the WINDOW characters immediately before the
  // marker string — i.e. on the same element's opening tag.
  function monoAppliesBefore(source: string, marker: string, window = 300): boolean {
    const idx = source.indexOf(marker);
    if (idx === -1) throw new Error(`marker not found in source: ${marker}`);
    const preceding = source.slice(Math.max(0, idx - window), idx);
    return /font-mono|text-mono-data/.test(preceding);
  }

  it("the demo's task-type/model line is mono", () => {
    const source = readSibling("_conversation-demo.tsx");
    expect(monoAppliesBefore(source, "Task type:")).toBe(true);
  });

  it("the demo's dollar-estimate line is mono", () => {
    const source = readSibling("_conversation-demo.tsx");
    expect(monoAppliesBefore(source, "budget: ~$")).toBe(true);
  });

  it("the demo's outcome ping is mono", () => {
    const source = readSibling("_conversation-demo.tsx");
    expect(monoAppliesBefore(source, "{getDemoOutcomeMessage()}")).toBe(true);
  });

  it("the trust-strip track-record numbers render in font-mono", () => {
    const source = readSibling("page.tsx");
    expect(monoAppliesBefore(source, "{TRACK_RECORD.shipped}")).toBe(true);
    expect(monoAppliesBefore(source, "{TRACK_RECORD.failed}")).toBe(true);
  });

  it("the how-we-work step markers are mono", () => {
    const source = readSibling("page.tsx");
    expect(monoAppliesBefore(source, "{i + 1}")).toBe(true);
  });
});

describe("(marketing) craft pins — font stack", () => {
  it("no third display font (e.g. next/font/google) is loaded — Inter + Berkeley Mono only, per TASTE.md", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).not.toMatch(/next\/font\/google/);
    }
  });
});

describe("(marketing) craft pins — copy: em-dash budget", () => {
  // Count em-dashes appearing in actual rendered string literals (the
  // JACE_DOES / HOW_WE_WORK arrays and inline JSX text), not JSDoc/inline
  // comments. Strip `/** ... */`, `// ...`, and `{/* ... */}` blocks first
  // so the count reflects what a visitor actually reads, matching how the
  // slop-audit's CO-1 finding was scoped (~6 render vs 56 in raw source).
  function stripComments(source: string): string {
    return source
      .replace(/\/\*\*[\s\S]*?\*\//g, "") // JSDoc blocks
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
      .replace(/^\s*\/\/.*$/gm, ""); // line comments
  }

  it("page.tsx's rendered copy has at most 2 em-dashes total", () => {
    const stripped = stripComments(readSibling("page.tsx"));
    const count = (stripped.match(/—/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(2);
  });

  it("the demo's illustrative user message has zero em-dashes (not drift-guarded, free to tighten)", () => {
    const source = readSibling("_conversation-demo-data.ts");
    const messageLine = source.split("\n").find((l) => l.includes("DEMO_USER_MESSAGE ="));
    // DEMO_USER_MESSAGE is a two-line literal; check the line after the
    // declaration, which holds the actual string.
    const idx = source.indexOf("export const DEMO_USER_MESSAGE");
    const messageLiteral = source.slice(idx, idx + 200);
    expect(messageLiteral.match(/—/g)).toBeNull();
    // Sanity: the constant still exists and still isn't empty.
    expect(messageLine).toBeDefined();
  });
});
