import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Cross-language gate-parity — TS leg (issue #1042).
//
// The queue entrance is guarded by TWO real implementations that must never
// silently disagree: the TypeScript gate (../queries/github_intake.ts) and the
// Python gate (agentrail/guardrails/policies/input_contract.py). This suite is the
// authoritative cross-language comparator. It:
//
//   1. Loads the ONE shared fixture corpus (the same JSON both gates read).
//   2. Computes the REAL TS gate's verdict per fixture, in-process, via screenV2
//      (the gate is NOT stubbed — only ../db.js is mocked so the module imports
//      without a DB, exactly as the existing v2 suite does; screenV2 is pure).
//   3. Shells out to `python -m agentrail.guardrails.parity.emit_verdicts` to get
//      the REAL Python gate's verdict per fixture (again unstubbed).
//   4. Diffs the two maps fixture-for-fixture and fails with a readable diff
//      naming the fixture id, the TS verdict, and the Python verdict on any
//      disagreement.
//
// This runs in the `node` CI job (setup-node + pnpm), which has python3
// preinstalled and where the pure Python gate imports with only PYTHONPATH (no
// `pip install`). The `python` CI job cannot import the TS gate (it needs
// drizzle/postgres, absent there), so THIS is where the true cross-language diff
// lives — if it were dropped anywhere the `node` job doesn't execute it would
// false-green.
//
// Zero per-fixture registration: both sides iterate whatever cases the corpus
// currently holds, so a fixture added to the corpus with no other code change is
// exercised by both legs on the next run (AC3).
// ---------------------------------------------------------------------------

// The db module is mocked so importing the gate module is side-effect free (its
// module scope constructs a client). The gate FUNCTION under test (screenV2) is
// pure and never touches the db — it is NOT mocked.
import { vi } from "vitest";
vi.mock("../db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] as unknown[] }) }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => [{ id: "row-id" }] }),
      }),
    }),
  },
}));

import {
  screenV2,
  AdmissionLedger,
  WriterClass,
  type V2Verdict,
} from "../queries/github_intake.js";

// ---------------------------------------------------------------------------
// Shared corpus — resolved the SAME way the v2 suite resolves it (up from this
// test file to the repo root, read with fs). Single-sourced: no forked list.
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
// .../packages/db-postgres/src/__tests__ → repo root is four levels up.
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const CORPUS_PATH = join(
  REPO_ROOT,
  "agentrail",
  "guardrails",
  "fixtures",
  "injection_corpus.json"
);

type Case = {
  id: string;
  expect: "reject" | "admit";
  category: "injection" | "negative_control";
  body: string;
  note?: string;
};
type Corpus = { version: number; cases: Case[] };

function loadCorpus(): Corpus {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;
}

// The canonical three-value admission vocabulary shared by both gates. The Python
// emitter produces exactly these strings; the TS gate's V2Verdict.decision is
// exactly these strings. This constant is the explicit, asserted mapping.
const CANONICAL_DECISIONS = ["admit", "park", "reject"] as const;
type CanonicalDecision = (typeof CANONICAL_DECISIONS)[number];

type Verdict = { decision: CanonicalDecision; reason: string };

// ---------------------------------------------------------------------------
// The REAL TS gate's verdict for one issue body, mapped to the canonical shape.
// A fresh ledger per case, injectionPark:false — so an injection probe is a hard
// REJECT and the stateful dedup/rate-limit checks never fire. This isolates the
// same decision surface the single-body corpus expresses, matching the Python
// emitter (which also uses a fresh ledger + injection_park=False per fixture).
// ---------------------------------------------------------------------------
function tsVerdict(body: string): Verdict {
  const v: V2Verdict = screenV2({
    body,
    writer: WriterClass.HUMAN_GITHUB,
    ledger: new AdmissionLedger(),
    injectionPark: false,
  });
  // V2Verdict.decision is already one of admit|park|reject; reason is present on
  // the non-admit variants. Normalise to the canonical {decision, reason} shape.
  if (v.decision === "admit") return { decision: "admit", reason: "" };
  return { decision: v.decision, reason: v.reason };
}

function tsVerdictMap(): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  for (const c of loadCorpus().cases) out[c.id] = tsVerdict(c.body);
  return out;
}

// ---------------------------------------------------------------------------
// The REAL Python gate's verdict map, obtained by shelling out to the shared
// emitter module. cwd + PYTHONPATH are the repo root so the pure gate imports
// with no `pip install` (matching the node CI job). We try `python3` then
// `python` so it works both on GitHub's ubuntu runner and locally.
// ---------------------------------------------------------------------------
function pythonVerdictMap(): Record<string, Verdict> {
  const args = ["-m", "agentrail.guardrails.parity.emit_verdicts"];
  const opts = {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    encoding: "utf8" as const,
  };

  let last = "";
  for (const interpreter of ["python3", "python"]) {
    const res = spawnSync(interpreter, args, opts);
    if (res.error) {
      // interpreter not found → try the next one.
      last = `${interpreter}: ${res.error.message}`;
      continue;
    }
    if (res.status !== 0) {
      throw new Error(
        `python emitter exited ${res.status} (via ${interpreter}):\n` +
          `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`
      );
    }
    return JSON.parse(res.stdout) as Record<string, Verdict>;
  }
  throw new Error(`could not launch a python interpreter for the parity emitter. ${last}`);
}

describe("cross-language gate parity (issue #1042)", () => {
  it("maps the Python and TS decision vocabularies onto the same three values", () => {
    // Explicit enum equality: the strings the Python emitter can produce MUST be
    // exactly the strings the TS gate can produce. If either side adds/renames a
    // verdict, this pins the contract and the diff below would go undefined.
    expect([...CANONICAL_DECISIONS]).toEqual(["admit", "park", "reject"]);

    // Every Python verdict decision is one of the canonical three.
    for (const [id, v] of Object.entries(pythonVerdictMap())) {
      expect(CANONICAL_DECISIONS, `python decision for ${id}`).toContain(v.decision);
    }
    // Every TS verdict decision is one of the canonical three.
    for (const [id, v] of Object.entries(tsVerdictMap())) {
      expect(CANONICAL_DECISIONS, `ts decision for ${id}`).toContain(v.decision);
    }
  });

  it("both gates rule on exactly the same fixture set (no per-fixture registration)", () => {
    const ts = tsVerdictMap();
    const py = pythonVerdictMap();
    const corpusIds = new Set(loadCorpus().cases.map((c) => c.id));
    expect(new Set(Object.keys(ts))).toEqual(corpusIds);
    expect(new Set(Object.keys(py))).toEqual(corpusIds);
  });

  it("the two gates agree on the decision for every fixture", () => {
    const ts = tsVerdictMap();
    const py = pythonVerdictMap();

    // Readable per-fixture disagreement diff: id, TS verdict, Python verdict.
    const disagreements: string[] = [];
    for (const id of Object.keys(ts).sort()) {
      const t = ts[id];
      const p = py[id];
      if (!p) {
        disagreements.push(`  ${id}: ts=${t.decision} but MISSING from python map`);
        continue;
      }
      if (t.decision !== p.decision) {
        disagreements.push(
          `  ${id}: ts=${t.decision} (${t.reason || "-"}) ` +
            `!= python=${p.decision} (${p.reason || "-"})`
        );
      }
    }

    expect(
      disagreements,
      `The Python and TypeScript queue-entrance gates DISAGREE on ` +
        `${disagreements.length} fixture(s):\n${disagreements.join("\n")}\n` +
        `This is a real cross-language parity bug — the gates must be reconciled, ` +
        `not the test weakened.`
    ).toEqual([]);
  });

  it("agrees with the shared corpus contract too (both gates match `expect`)", () => {
    // Belt-and-braces: not only do the gates agree with each other, they agree
    // with the corpus's language-neutral `expect` field, so a gate that is wrong
    // in the SAME way on both sides still fails here.
    const ts = tsVerdictMap();
    const py = pythonVerdictMap();
    const wrong: string[] = [];
    for (const c of loadCorpus().cases) {
      const expected = c.expect; // "reject" | "admit"
      if (ts[c.id].decision !== expected) {
        wrong.push(`  ${c.id}: expect=${expected} but ts=${ts[c.id].decision}`);
      }
      if (py[c.id].decision !== expected) {
        wrong.push(`  ${c.id}: expect=${expected} but python=${py[c.id].decision}`);
      }
    }
    expect(wrong, `gate(s) disagree with corpus contract:\n${wrong.join("\n")}`).toEqual([]);
  });
});
