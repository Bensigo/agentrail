import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Default-theme drift guard (#1282).
//
// This app's vitest environment is "node" (see vitest.config.ts) — no jsdom,
// so the toggle can't be rendered and clicked here. Instead this pins the
// SOURCE of the three places that decide the default theme, the same
// "read the file's own text at test time" pattern lib/alignment/catalog.test.ts
// uses for its cross-language pricing guard. A flip back to dark-by-default
// (accidental revert, bad merge, copy-pasted old snippet) fails one of these
// regexes instead of silently shipping.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let layoutSource: string;
let globalsCssSource: string;
let themeToggleSource: string;

beforeAll(() => {
  layoutSource = readFileSync(resolve(__dirname, "layout.tsx"), "utf8");
  globalsCssSource = readFileSync(resolve(__dirname, "globals.css"), "utf8");
  themeToggleSource = readFileSync(
    resolve(__dirname, "components/theme-toggle.tsx"),
    "utf8"
  );
});

describe("default theme is light (#1282 AC1)", () => {
  it("root <html> carries no unconditional dark class", () => {
    // The old default was `<html lang="en" className="dark">`. Any
    // `className` on the root <html> tag today would mean a hardcoded
    // theme leaked back in — the class is now applied only by the inline
    // script below, at runtime, from the stored preference.
    const htmlTagMatch = layoutSource.match(/<html\b[^>]*>/);
    expect(htmlTagMatch, "expected an <html> tag in layout.tsx").not.toBeNull();
    expect(htmlTagMatch![0]).not.toMatch(/className/);
  });

  it("inline pre-hydration script defaults to light: only a stored 'dark' opts in", () => {
    const scriptMatch = layoutSource.match(/__html:\s*`([^`]+)`/);
    expect(
      scriptMatch,
      "expected the dangerouslySetInnerHTML script"
    ).not.toBeNull();
    const script = scriptMatch![1];

    // Persistence key is unchanged by the flip.
    expect(script).toContain("agentrail-theme");
    // Dark is the opt-in branch: only exactly "dark" adds the class.
    expect(script).toMatch(
      /t===['"]dark['"]\)\{document\.documentElement\.classList\.add\(['"]dark['"]\)/
    );
    // Everything else (including a first-ever visit's null) removes it — no
    // bare default-to-dark `else{...classList.add(...)}` left from before.
    expect(script).toMatch(
      /\}else\{document\.documentElement\.classList\.remove\(['"]dark['"]\)/
    );
  });
});

describe("theme-toggle.tsx mount state matches the light default", () => {
  it("initial React state is light (dark=false)", () => {
    expect(themeToggleSource).toMatch(/useState\(false\)/);
  });

  it("mount-effect only flips to dark for an explicit stored 'dark'", () => {
    expect(themeToggleSource).toMatch(/stored === ["']dark["']/);
    expect(themeToggleSource).not.toMatch(/stored === ["']light["']/);
  });

  it("persists under the same key the layout script reads", () => {
    expect(themeToggleSource).toContain("agentrail-theme");
  });
});

describe("color-scheme follows the toggle (#1282 AC1, annex Q10)", () => {
  it(":root declares light color-scheme, .dark overrides to dark", () => {
    const rootBlockMatch = globalsCssSource.match(/:root\s*\{([^}]*)\}/s);
    expect(rootBlockMatch, "expected a :root block").not.toBeNull();
    expect(rootBlockMatch![1]).toMatch(/color-scheme:\s*light;/);

    const darkBlockMatch = globalsCssSource.match(/\.dark\s*\{([^}]*)\}/s);
    expect(darkBlockMatch, "expected a .dark block").not.toBeNull();
    expect(darkBlockMatch![1]).toMatch(/color-scheme:\s*dark;/);
  });

  it("no unconditional html{color-scheme} rule survives (would never react to the toggle)", () => {
    // Before the fix this lived at an unscoped `html { color-scheme: dark; }`
    // rule, which never reacted to the `.dark` class at all (annex §5).
    expect(globalsCssSource).not.toMatch(/html\s*\{\s*color-scheme:/);
  });
});
