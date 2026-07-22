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

// Landing v2 (docs/superpowers/plans/2026-07-22-landing-v2.md): the pinned
// scroll scene is retired in favor of the hero phone (`_phone-demo.tsx`),
// which joins the set. Every styled marketing file is held to the BAN rules
// (weights, ad-hoc sizes, lemon-as-text, text-white on a fill, semantic
// yellow) …
const STYLED_FILES = [
  "page.tsx",
  "_conversation-demo.tsx",
  "_nav.tsx",
  "_phone-demo.tsx",
  "_use-cases.tsx",
  "_channels.tsx",
  "_stats.tsx",
] as const;

// … while the EXISTENCE assertions (must actually carry the lemon fill +
// dark fill-text pairing) apply only to the files that render a filled
// element. _phone-demo.tsx is deliberately absent here: it renders chrome
// around `ConversationDemo` (whose Approve button carries the fill), and
// demanding a second fill of the frame would force decoration into it.
const LEMON_FILL_FILES = [
  "page.tsx",
  "_conversation-demo.tsx",
  "_nav.tsx",
  "_channels.tsx",
] as const;

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
  // Review fix M-4: the old single pin required EVERY styled file to
  // contain a lemon fill, which breaks the moment a legitimately
  // fill-free file (scroll plumbing) joins the set. Split: bans sweep all
  // styled files; existence asserts only on the files that must carry it.
  it.each(STYLED_FILES)("%s never pairs a lemon fill with text-white", (file) => {
    const source = readSibling(file);
    expect(source).not.toMatch(/bg-\[var\(--accent-(?:fill|text)\)\][^"]*text-white/);
    expect(source).not.toMatch(/bg-\[var\(--brand-accent\)\][^"]*text-white/);
  });

  it.each(LEMON_FILL_FILES)("%s carries the lemon fill paired with the dark fill-text token", (file) => {
    const source = readSibling(file);
    expect(source).toMatch(/bg-\[var\(--accent-fill\)\]/);
    expect(source).toMatch(/text-\[var\(--accent-fill-text\)\]/);
  });

  it("filled buttons hover via the hover token, not an opacity fade", () => {
    for (const file of LEMON_FILL_FILES) {
      expect(readSibling(file)).toMatch(/hover:bg-\[var\(--accent-fill-hover\)\]/);
    }
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
  it("the hero opens with the canonical wave render, named for assistive tech", () => {
    const source = readSibling("page.tsx");
    expect(source).toMatch(/src="\/jace-wave\.png"[\s\S]{0,40}alt="Jace"/);
  });

  it("the nav mark is the canonical avatar render (wordmark adjacent carries the name)", () => {
    const source = readSibling("_nav.tsx");
    expect(source).toMatch(/src="\/jace-avatar\.png"/);
  });

  it("the phone header carries the canonical avatar render", () => {
    const source = readSibling("_phone-demo.tsx");
    expect(source).toMatch(/src="\/jace-avatar\.png"/);
  });

  it("the overnight use-case carries the canonical working render, exactly once", () => {
    const source = readSibling("_use-cases.tsx");
    const occurrences = source.match(/src="\/jace-working\.png"/g) ?? [];
    expect(occurrences.length).toBe(1);
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

  it("the live numbers render in font-mono (landing v2: CountUp carries the mono class beside each {stats.*} marker)", () => {
    const source = readSibling("page.tsx");
    expect(monoAppliesBefore(source, "{stats.shipped}")).toBe(true);
    expect(monoAppliesBefore(source, "{stats.workedOn}")).toBe(true);
    expect(monoAppliesBefore(source, "{stats.didntLand}")).toBe(true);
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

  it("the static tilt uses Tailwind's named rotate scale (rotate-1/2/3, not arbitrary values) on the stat scraps and the closing mascot", () => {
    const source = readSibling("page.tsx");
    const matches = source.match(/-?rotate-\d/g) ?? [];
    // 2 tilted stat scraps + 1 closing mascot = 3 static tilts. The
    // didn't-land card is DELIBERATELY untilted — its difference from the
    // other two is the slop audit's LS-1/LS-2 fix; don't "even it up".
    expect(matches.length).toBeGreaterThanOrEqual(3);
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

  it("page.tsx renders exactly three mascot beats (wave hero + closing + footer mark), all from the owner-supplied canon set", () => {
    const source = readSibling("page.tsx");
    // Canon renders (TASTE.md): jace.png, jace-avatar.png, jace-wave.png,
    // jace-working.png — owner-supplied, never generated substitutes.
    const canon = source.match(/src="\/jace(?:-avatar|-wave|-working)?\.png"/g) ?? [];
    expect(canon.length).toBe(3);
    const anyJaceImage = source.match(/src="\/jace[^"]*"/g) ?? [];
    expect(anyJaceImage.length).toBe(canon.length);
  });

  it("sub-14px text never sits in --gray-09/--gray-10 on the landing (slop-audit GQ-1: 4.5:1 floor on --paper)", () => {
    for (const file of STYLED_FILES) {
      const source = readSibling(file);
      const smallText = source.match(/className="[^"]*text-(?:body-sm|label)[^"]*"/g) ?? [];
      for (const attr of smallText) {
        expect(attr).not.toMatch(/--gray-(?:09|10)/);
      }
    }
  });
});

describe("(marketing) craft pins — landing v2 additions", () => {
  it("styled components other than page.tsx carry zero hex colors (tokens only; page.tsx's LIGHT_SURFACE defines the tokens)", () => {
    // Comments legitimately hold issue refs ("#1279") that a bare hex regex
    // would eat — check rendered/code text only, same stripping approach as
    // the em-dash budget below.
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*\*[\s\S]*?\*\//g, "")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    for (const file of STYLED_FILES.filter((f) => f !== "page.tsx")) {
      const source = stripComments(readSibling(file));
      expect(source.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9])/)).toBeNull();
    }
  });

  it("the typing-cursor motif stays within budget: 1–2 ar-cursor markers in page.tsx, nowhere else", () => {
    const pageCount = (readSibling("page.tsx").match(/ar-cursor/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(1);
    expect(pageCount).toBeLessThanOrEqual(2);
    for (const file of STYLED_FILES.filter((f) => f !== "page.tsx")) {
      expect(readSibling(file)).not.toMatch(/ar-cursor/);
    }
  });
});
