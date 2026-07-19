import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Mechanical craft pins for the dashboard de-slop sweep (2026-07-19),
// mirroring the (marketing) lane's tokens-only test
// (`_conversation-demo.tokens-only.test.ts`) — same idea, applied to
// TASTE.md's Typography rules instead of its Color System rules. These
// enforce the RULES, not today's file contents, so they stay meaningful
// after future edits instead of pinning a snapshot. Read TASTE.md's
// "Console Design Guide" → Typography / Component Patterns before touching
// the detectors below; they encode that text, not invented house style.
//
// Scope is deliberately the AUDITED surfaces only (Home, Work, Approvals,
// Runs, Costs, Budget, Failures, Review Gates, Permissions, the setup
// wizard, and the shared (dashboard)/components/ primitives) — the same set
// named in the craft-sweep brief. Memory/Connectors/Repos/Members/Teams were
// never in scope for this pass and are excluded here too, so this file
// doesn't fail on surfaces nobody has swept yet; widen AUDITED_ROOTS when
// they get their own pass.

const DASHBOARD_APP_DIR = fileURLToPath(new URL(".", import.meta.url));

const AUDITED_ROOTS = [
  "dashboard/page.tsx",
  "dashboard/[workspaceId]/page.tsx",
  "dashboard/[workspaceId]/loading.tsx",
  "dashboard/[workspaceId]/error.tsx",
  "dashboard/[workspaceId]/layout.tsx",
  "dashboard/[workspaceId]/components",
  "dashboard/[workspaceId]/work",
  "dashboard/[workspaceId]/approvals",
  "dashboard/[workspaceId]/runs",
  "dashboard/[workspaceId]/review-gates",
  "dashboard/[workspaceId]/costs",
  "dashboard/[workspaceId]/budget",
  "dashboard/[workspaceId]/failures",
  "dashboard/[workspaceId]/permissions",
  "components",
  "setup",
];

// WorkspaceSwitcher's palette/layout is explicitly protected this round (see
// the craft-sweep brief) — nobody fixed its findings, so it can't be in this
// pin's enforcement set yet. Lift this exclusion when it gets its own pass.
const EXCLUDED = new Set(["components/WorkspaceSwitcher.tsx"]);

function collectSourceFiles(
  relRoot: string,
  excluded: Set<string>,
  out: string[] = []
): string[] {
  const full = join(DASHBOARD_APP_DIR, relRoot);
  const stat = statSync(full);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(full)) {
      collectSourceFiles(join(relRoot, entry), excluded, out);
    }
    return out;
  }
  if (!/\.tsx?$/.test(relRoot)) return out;
  if (/\.test\.tsx?$/.test(relRoot)) return out;
  if (excluded.has(relRoot)) return out;
  out.push(relRoot);
  return out;
}

const AUDITED_FILES = AUDITED_ROOTS.flatMap((root) =>
  collectSourceFiles(root, EXCLUDED)
);

// The retired-hex-literal pin (below) deliberately scans the FULL
// `(dashboard)/` tree, not just AUDITED_FILES: unlike the weight/size/mono
// rules (which only make sense to enforce on surfaces someone has actually
// swept), a fully-retired color literal has zero legitimate uses anywhere,
// including WorkspaceSwitcher.tsx and the not-yet-audited
// Memory/Connectors/Repos/Members/Teams surfaces — so nothing is excluded
// here.
const ALL_DASHBOARD_FILES = collectSourceFiles(".", new Set());

function readLines(relPath: string): string[] {
  return readFileSync(join(DASHBOARD_APP_DIR, relPath), "utf8").split("\n");
}

// TASTE.md Typography: "Font weights: Regular (400) for body/data, Bold
// (700) for headings and emphasis. No thin or black weights." Component
// Patterns never sanctions any of these five — zero tolerance, no
// comment-escape-hatch (unlike font-medium and ad-hoc sizes below, which DO
// have guide-sanctioned or comment-justified exceptions).
const ALWAYS_BANNED_WEIGHT = /font-(semibold|extrabold|black|thin|light)\b/;

// font-medium has exactly two guide-sanctioned shapes (TASTE.md Component
// Patterns):
//   (a) Data Table column headers — "text-xs uppercase text-gray-09
//       font-medium"
//   (b) Status Badges — "Compact: px-1.5 py-0.5 rounded-sm text-xs
//       font-medium"
// (a) is detected by the `<th` tag itself, NOT by co-occurring text-xs/
// uppercase/gray-09 utility classes: this codebase consistently sets
// `text-xs` (and sometimes `uppercase`/color) once on the ancestor
// `<table>`/`<tr>` and lets every `<th>` inherit it — correct, DRY CSS, but
// invisible to a same-line-only scan. `<th>` is structurally unambiguous
// ("this is a data table header") and a far more reliable signal than
// pattern-matching utility classes that may legitimately live one or two
// elements up. The tag itself is looked up to 3 lines back from the
// className line, not just same-line — Prettier commonly breaks
// `<th key={...} className="...">` across three lines, and a same-line-only
// check misses that real, common shape (see `runs-table.tsx`'s
// `getFlatHeaders().map` header cells for exactly this formatting).
//
// Deliberately NOT extended to "text-xs + uppercase + gray-09 co-occurring
// on any tag" as a blanket third shape: a `<div>`/`<h2>` styled to LOOK
// like a table header is a real, codebase-established judgment call (a
// waterfall chart's div-based column-header row IS sanctioned by analogy;
// a section `<h2>` with the identical classes is NOT — it's a heading by
// role and takes the Bold-for-headings rule instead, per TASTE.md's base
// Typography rule). A regex can't tell those apart; the comment-adjacency
// fallback below is what correctly handles the div-header case (it gets an
// explanatory comment), while the h2 case is fixed at the source instead
// (font-medium removed entirely) rather than routed through this
// exception. See `runs/[runId]/page.tsx`'s h2 comment and
// `waterfall-section.tsx`'s column-header comment for the two real
// examples this reasoning is drawn from.
//
// (b) has no tag to key off (badges are usually self-contained `<span>`s),
// so structure is approximated by the compact-pill padding+rounding combo
// alone — `text-xs` is NOT required on the same line, for the same
// ancestor-inheritance reason as (a): a badge nested in an already-`text-xs`
// container legitimately omits repeating it (see
// `behavior-lint-section.tsx`'s severity badge, whose size comes from its
// parent's `text-xs`, not its own className). Radius/padding are checked
// loosely (`rounded`/`rounded-sm`/`rounded-full`, `px-1`/`px-1.5`/`px-2`)
// rather than pinned to the guide's exact `rounded-sm`+`px-1.5` — this lint
// only pins weight/size/mono (per the brief), not radius precision, so a
// real badge using the codebase's plain `rounded` (4px) or a roomier `px-2`
// (e.g. an icon+label badge that needs the extra width) still counts as
// "structurally a badge" for font-medium purposes even if its radius token
// could separately be tightened to `rounded-sm` — see
// `telemetry-health-section.tsx`'s Present/Missing pills (`rounded`, not
// `rounded-sm`) and `failure-actions.tsx`'s severity badges (`px-2`, not
// `px-1.5`) for the two real shapes this was calibrated against. Anything
// matching neither shape must carry a justifying comment (the brief's
// "every exception gets an inline comment" rule) on the same line or
// immediately adjacent.
const FONT_MEDIUM = /font-medium\b/;
function isSanctionedFontMedium(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const tableHeaderShape = [lines[idx - 3], lines[idx - 2], lines[idx - 1], line].some(
    (l) => l !== undefined && /<th\b/.test(l)
  );
  const statusBadgeShape =
    /\brounded(-sm|-full)?\b/.test(line) && /px-[12](\.5)?\b/.test(line);
  return tableHeaderShape || statusBadgeShape;
}

// Ad-hoc arbitrary pixel sizes that don't map to TASTE.md's type scale
// (heading-1/2, body 14px, body-sm/label 12px, mono-data 13px) are FOUND
// violations UNLESS: (a) it's the mono-data scale step spelled as an
// arbitrary value (13px, paired with font-mono, per the guide's mono-data
// row) rather than a named token, or (b) a nearby comment justifies a real
// space constraint.
const AD_HOC_SIZE = /text-\[(\d+)px\]/;

// Detectors must scan CODE, not comments. A multi-line `{/* ... */}` block
// explaining *why* a weight was or wasn't used (exactly the kind of
// exception-justifying comment this file's own rules ask authors to write)
// will itself say "font-medium" or "text-[10px]" in prose — a naive
// per-line regex over raw file text flags that prose as if it were a real
// className, which is backwards: the comment is the justification, not the
// violation. `computeCommentMask` marks every line that's wholly inside a
// `{/* */}` block or a `//`-prefixed line, tracking open AND close state so
// a block's LAST line (which contains only the closing `*/`, not a fresh
// `/*` or `//`) is still recognized as a comment line — a purely
// same-line/prefix regex misses that closing line, which matters a lot for
// `hasNearbyComment` below: a violation sitting immediately after a
// multi-line block's closing line is "adjacent to a comment" in every
// practical sense, and must read as justified.
function computeCommentMask(lines: string[]): boolean[] {
  let inBlock = false;
  return lines.map((raw) => {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      return true;
    }
    if (line.startsWith("//")) return true;
    if (line.includes("/*")) {
      if (!line.includes("*/")) inBlock = true;
      return true;
    }
    return false;
  });
}

// A genuine code-line violation is "justified" if a comment sits on the
// same, previous, or next line — built on the SAME mask as the skip-check
// above (not a separate regex) so the two notions of "comment" can't drift
// out of sync with each other.
function hasNearbyComment(mask: boolean[], idx: number): boolean {
  return [mask[idx - 1], mask[idx], mask[idx + 1]].some(Boolean);
}

describe("dashboard craft pins (TASTE.md Typography, 2026-07-19 sweep)", () => {
  it("audits at least the ten named surfaces plus shared components (sanity: the file collector isn't silently empty)", () => {
    expect(AUDITED_FILES.length).toBeGreaterThan(20);
  });

  // Owner-directed accent-token corrections landed on main mid-sweep (three
  // rounds: golden+deep-green, then final lemon+black — see globals.css's
  // --brand-accent/--accent-text/--accent-fill* history). #9e6c00 ("mustard")
  // was the FIRST agent-invented accent, retired outright — it has zero
  // legitimate use anywhere in (dashboard)/, including surfaces this sweep
  // didn't otherwise touch, so this scans ALL_DASHBOARD_FILES rather than
  // just AUDITED_FILES. Case-insensitive: a hex literal is the same color
  // whether typed upper or lower case.
  it("no #9e6c00 (the retired 'mustard' literal) anywhere in (dashboard)/", () => {
    const violations: string[] = [];
    for (const file of ALL_DASHBOARD_FILES) {
      readLines(file).forEach((line, i) => {
        if (/9e6c00/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no font-semibold / font-extrabold / font-black / font-thin / font-light across the audited surfaces", () => {
    const violations: string[] = [];
    for (const file of AUDITED_FILES) {
      const lines = readLines(file);
      const isComment = computeCommentMask(lines);
      lines.forEach((line, i) => {
        if (!isComment[i] && ALWAYS_BANNED_WEIGHT.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every font-medium is either the guide's table-header/status-badge shape or has a justifying comment", () => {
    const violations: string[] = [];
    for (const file of AUDITED_FILES) {
      const lines = readLines(file);
      const isComment = computeCommentMask(lines);
      lines.forEach((line, i) => {
        if (
          !isComment[i] &&
          FONT_MEDIUM.test(line) &&
          !isSanctionedFontMedium(lines, i) &&
          !hasNearbyComment(isComment, i)
        ) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every ad-hoc text-[Npx] size is either the mono-data 13px step (with font-mono) or has a justifying comment", () => {
    const violations: string[] = [];
    for (const file of AUDITED_FILES) {
      const lines = readLines(file);
      const isComment = computeCommentMask(lines);
      lines.forEach((line, i) => {
        if (isComment[i]) return;
        const match = line.match(AD_HOC_SIZE);
        if (!match) return;
        const isMonoDataStep = match[1] === "13" && /font-mono/.test(line);
        if (!isMonoDataStep && !hasNearbyComment(isComment, i)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// Self-check: prove each detector catches the real failure mode AND doesn't
// false-positive on a realistic compliant line — so a future edit to a
// regex above that quietly stops matching (or starts over-matching) fails
// loudly here, not just silently passes the suite above for the wrong
// reason.
describe("craft-pin detector sanity", () => {
  it("ALWAYS_BANNED_WEIGHT matches semibold/extrabold/black/thin/light, not bold/normal/medium", () => {
    expect('className="font-semibold"').toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-extrabold"').toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-black"').toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-thin"').toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-light"').toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-bold"').not.toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-normal"').not.toMatch(ALWAYS_BANNED_WEIGHT);
    expect('className="font-medium"').not.toMatch(ALWAYS_BANNED_WEIGHT);
  });

  it("isSanctionedFontMedium recognizes the guide's table-header and status-badge shapes", () => {
    expect(
      isSanctionedFontMedium(
        ['<th className="text-xs uppercase text-gray-09 font-medium">'],
        0
      )
    ).toBe(true);
    expect(
      isSanctionedFontMedium(
        ['<span className="px-1.5 py-0.5 rounded-sm text-xs font-medium">'],
        0
      )
    ).toBe(true);
  });

  it("isSanctionedFontMedium accepts a <th> that inherits text-xs/uppercase/color from its ancestor <table>/<tr> instead of repeating them (regression: real code does this — see approvals/costs/budget table headers)", () => {
    expect(
      isSanctionedFontMedium(
        ['<th className="px-3 py-1.5 font-medium">Model</th>'],
        0
      )
    ).toBe(true);
  });

  it("isSanctionedFontMedium looks back up to 3 lines for a Prettier-broken <th ...\\n  className=...> tag, not just the same line (regression: real code does this — see runs-table.tsx's getFlatHeaders() header cells)", () => {
    const lines = [
      "<th",
      '  key={header.id}',
      '  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--gray-09)]"',
      ">",
    ];
    expect(isSanctionedFontMedium(lines, 2)).toBe(true);
  });

  it("isSanctionedFontMedium rejects an unrelated font-medium (e.g. a plain label)", () => {
    expect(
      isSanctionedFontMedium(
        ['<p className="text-sm font-medium text-gray-12">'],
        0
      )
    ).toBe(false);
  });

  it("computeCommentMask marks a multi-line {/* */} block as comment, even when its prose names a banned weight (regression: this exact shape false-positived before the mask existed — see runs/[runId]/page.tsx's real h2 comment)", () => {
    const lines = [
      "<div>",
      "  {/* font-bold, not font-medium: these h2s reuse the Data Table",
      "      header's label styling (text-xs uppercase gray-09) for a quiet",
      "      engine-room look, but TASTE.md's font-medium exception is scoped",
      "      to literal table headers and status badges. */}",
      '  <h2 className="mb-4 text-xs font-bold uppercase tracking-wide text-[var(--gray-09)]">',
      "</div>",
    ];
    const mask = computeCommentMask(lines);
    expect(mask).toEqual([false, true, true, true, true, false, false]);
    // The prose mentions "font-medium" twice, but every hit sits on a
    // masked line — a detector honoring the mask finds zero real violations
    // here, only the legitimate font-bold on the un-masked <h2> line.
    const realCodeLines = lines.filter((_, i) => !mask[i]);
    expect(realCodeLines.join(" ")).not.toContain("font-medium");
  });

  it("hasNearbyComment finds a comment on the same, previous, or next line, not two lines away", () => {
    const lines = [
      "// dense cell, 12px overflows at 3-digit counts",
      '<span className="text-[10px]">',
      "unrelated",
      "unrelated",
    ];
    const mask = computeCommentMask(lines);
    expect(hasNearbyComment(mask, 1)).toBe(true);
    expect(hasNearbyComment(mask, 3)).toBe(false);
  });

  it("hasNearbyComment also recognizes a multi-line block's CLOSING line (regression: a `*/` -only line has no `/*` or `//` of its own, so a naive same-line regex misses it — see waterfall-section.tsx's real column-header comment, which closes one line above its code)", () => {
    const lines = [
      "{/* Column headers — functionally the Data Table header pattern",
      "    (text-xs uppercase gray-09 font-medium) even though this is a bar",
      "    chart rather than a <table>. */}",
      '<div className="flex items-center justify-between text-xs uppercase tracking-wide text-[var(--gray-09)] font-medium">',
    ];
    const mask = computeCommentMask(lines);
    expect(hasNearbyComment(mask, 3)).toBe(true);
  });

  it("AD_HOC_SIZE's 13px+font-mono escape hatch only fires at exactly 13px", () => {
    expect(/font-mono/.test('className="text-[13px] font-mono"')).toBe(true);
    const match12 = 'className="text-[12px] font-mono"'.match(AD_HOC_SIZE);
    expect(match12?.[1]).toBe("12"); // not "13" — the mono-data escape hatch must not apply
  });
});
