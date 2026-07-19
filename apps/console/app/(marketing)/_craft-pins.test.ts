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

// _nav.tsx joined the set with the wave-4 narrative-flow redo (owner-directed
// — the floating pill nav now carries its own lemon-fill CTA button, so it's
// held to the same weight/size/accent rules as the other two).
const STYLED_FILES = ["page.tsx", "_conversation-demo.tsx", "_nav.tsx"] as const;

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

describe("(marketing) craft pins — accent system (lemon family, #1357/#1359)", () => {
  it("lemon fill pairs with the dark fill-text token on every filled element — never text-white", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).toMatch(/bg-\[var\(--accent-fill\)\]/);
      expect(source).toMatch(/text-\[var\(--accent-fill-text\)\]/);
      expect(source).not.toMatch(/bg-\[var\(--accent-(?:fill|text)\)\][^"]*text-white/);
      expect(source).not.toMatch(/bg-\[var\(--brand-accent\)\][^"]*text-white/);
    }
  });

  it("filled buttons hover via the hover token, not an opacity fade", () => {
    const page = readSibling("page.tsx");
    const demo = readSibling("_conversation-demo.tsx");
    expect(page).toMatch(/hover:bg-\[var\(--accent-fill-hover\)\]/);
    expect(demo).toMatch(/hover:bg-\[var\(--accent-fill-hover\)\]/);
  });

  it("the text accent (--accent-text) carries markers and link hovers", () => {
    const source = readSibling("page.tsx");
    const usages = source.match(/var\(--accent-text\)/g) ?? [];
    // More than the one `LIGHT_SURFACE` custom-property *definition* —
    // i.e. it's actually applied (step markers, bullet dots, link hovers).
    expect(usages.length).toBeGreaterThan(1);
  });

  it("lemon is NEVER text on light — no text-[var(--accent-fill)] / text-[var(--brand-accent)]", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).not.toMatch(/text-\[var\(--accent-fill\)\]/);
      expect(source).not.toMatch(/text-\[var\(--brand-accent\)\]/);
    }
  });

  it("semantic caution yellow is not used as brand: zero var(--yellow-09/-11) usages", () => {
    // The LIGHT_SURFACE block DEFINES --yellow-11 (semantic token mirror,
    // `["--yellow-11" as string]`) — that is not a usage. A usage is
    // `var(--yellow-…)` in a className/fill.
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).not.toMatch(/var\(--yellow-09\)/);
      expect(source).not.toMatch(/var\(--yellow-11\)/);
    }
  });

  it("the landing sits on the faint-lemon paper token", () => {
    const source = readSibling("page.tsx");
    expect(source).toMatch(/bg-\[var\(--paper\)\]/);
  });
});

describe("(marketing) craft pins — the mascot IS Jace (TASTE.md canon)", () => {
  it("the hero opens with the canonical mascot, named for assistive tech", () => {
    const source = readSibling("page.tsx");
    expect(source).toMatch(/src="\/jace\.png"[\s\S]{0,40}alt="Jace"/);
  });

  it("Jace's demo bubbles carry the mascot avatar (decorative alt, name text adjacent)", () => {
    const source = readSibling("_conversation-demo.tsx");
    const avatars = source.match(/src="\/jace\.png"/g) ?? [];
    expect(avatars.length).toBeGreaterThanOrEqual(2);
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

  it("the track-record numbers render in font-mono, including 'attempted' (wave-4 addition — it existed in TRACK_RECORD but was never rendered before)", () => {
    const source = readSibling("page.tsx");
    expect(monoAppliesBefore(source, "{TRACK_RECORD.shipped}")).toBe(true);
    expect(monoAppliesBefore(source, "{TRACK_RECORD.attempted}")).toBe(true);
    expect(monoAppliesBefore(source, "{TRACK_RECORD.failed}")).toBe(true);
  });

  it("the how-we-work step markers are mono", () => {
    const source = readSibling("page.tsx");
    expect(monoAppliesBefore(source, "{i + 1}")).toBe(true);
  });
});

describe("(marketing) craft pins — font stack", () => {
  it("page/demo load no fonts of their own — the display serif lives in layout.tsx only", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      expect(source).not.toMatch(/next\/font\/google/);
    }
  });

  it("layout.tsx loads exactly the sanctioned display serif (Source Serif 4), nothing else", () => {
    const layout = readSibling("layout.tsx");
    // The ONE sanctioned next/font/google load in (marketing)/ — the
    // round-2/3 ruling: upright serif display voice, landing-scoped.
    expect(layout).toMatch(/Source_Serif_4/);
    // The rejected font stays rejected (round-1 owner feedback), and no
    // second font sneaks in beside the serif. Matches the import
    // IDENTIFIER (underscore form) so a prose mention of the ban in a
    // comment doesn't trip it.
    const fontImports = layout.match(/from "next\/font\/google"/g) ?? [];
    expect(fontImports.length).toBe(1);
    expect(layout).not.toMatch(/Bricolage_Grotesque/);
  });

  it("the serif applies through the display heading classes (h1 + section h2s), not body text", () => {
    const layout = readSibling("layout.tsx");
    expect(layout).toMatch(/\.text-heading-1,\s*\n\s*\.text-heading-2 \{\s*\n\s*font-family: var\(--font-display\)/);
  });

  it("no italic serif display — the hero serif stays upright (slop-catalog TY-3)", () => {
    const layout = readSibling("layout.tsx");
    const page = readSibling("page.tsx");
    expect(layout).not.toMatch(/font-style:\s*italic/);
    expect(page).not.toMatch(/\bitalic\b/);
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

describe("(marketing) craft pins — narrative flow (wave 4)", () => {
  // Two new patterns this redo introduces, pinned per the task brief's own
  // examples: "allow the rotation utility, pin the lemon-scene text
  // pairing."

  it("the static tilt uses Tailwind's named rotate scale (rotate-1/2/3, not arbitrary values) on the track-record cards and the closing mascot", () => {
    const source = readSibling("page.tsx");
    const matches = source.match(/-?rotate-\d/g) ?? [];
    // 3 track-record cards + 1 closing mascot = 4 static tilts.
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it("the rotation is a static transform, never animated or transitioned", () => {
    const source = readSibling("page.tsx");
    // A `transition`/`animate-` utility living on the exact same class
    // string as a rotate utility would mean the tilt itself is animating,
    // which the spec explicitly rules out ("one-time, not animated").
    const rotateClassAttrs = source.match(/className="[^"]*-?rotate-\d[^"]*"/g) ?? [];
    expect(rotateClassAttrs.length).toBeGreaterThan(0);
    for (const attr of rotateClassAttrs) {
      expect(attr).not.toMatch(/transition|animate-/);
    }
  });

  it("the full-bleed lemon scene (how-we-work) pairs its background with the dark fill-text token, never a gray body-text token", () => {
    const source = readSibling("page.tsx");
    const idx = source.indexOf("HOW_WE_WORK.map");
    expect(idx).toBeGreaterThan(-1);
    const window = source.slice(idx, idx + 700);
    expect(window).toMatch(/text-\[var\(--accent-fill-text\)\]/);
    // Guards against CC-4 (gray text on a colored background) creeping back
    // in — --gray-09/10/11 are exactly the tones the rest of the page uses
    // for body text on --paper, which would wash out on --accent-fill.
    expect(window).not.toMatch(/text-\[var\(--gray-(?:09|10|11)\)\]/);
  });

  it("the full-bleed lemon scene actually breaks full-bleed (no inner max-width on the section itself)", () => {
    const source = readSibling("page.tsx");
    const idx = source.indexOf('bg-[var(--accent-fill)] px-6 py-24');
    expect(idx).toBeGreaterThan(-1);
    const sectionOpenTag = source.slice(Math.max(0, idx - 120), idx + 40);
    expect(sectionOpenTag).not.toMatch(/max-w-/);
  });

  it("the mascot still appears exactly twice in page.tsx (hero + one more narrative beat), never a third fabricated pose", () => {
    const source = readSibling("page.tsx");
    const occurrences = source.match(/src="\/jace\.png"/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
