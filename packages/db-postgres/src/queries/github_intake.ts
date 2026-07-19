import { createHash } from "crypto";
import { sql, and, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { queueEntries } from "../schema/queue_entries.js";
import { workspaces } from "../schema/workspaces.js";
import { jaceApprovals } from "../schema/jace_sessions.js";

/**
 * Server-side GitHub issue intake — the webhook half of the Issue Queue.
 *
 * The runner model puts the queue on the backend, so admitting a GitHub issue is
 * a SERVER job: a delivered `issues` webhook lands here, we apply the same
 * input-contract gate the Python store uses (machine-checkable acceptance
 * criteria), resolve which workspace owns the repo, and persist a durable
 * `queue_entries` row. The already-built `/api/v1/runner/claim` then hands it to
 * the logged-in runner. This mirrors `agentrail/heartbeat/webhook.py` +
 * `agentrail/afk/input_contract.py` + `agentrail/afk/queue_store.py` so an issue
 * admitted by webhook is identical to one admitted by the Python path (same
 * deterministic row id → dedupe across both).
 */

// --- the input-contract gate (port of input_contract.validate) ---------------

// The `## Acceptance criteria` section, then a checkbox line inside it. Mirrors
// the Python regexes exactly so the two gates agree.
const AC_SECTION =
  /^#{1,6}\s*acceptance\s+criteria\b.*?\n([\s\S]*?)(?=^#{1,6}\s|$(?![\s\S]))/im;
const CHECKBOX = /^\s*[-*+]\s*\[[ xX]\]\s*(.+?)\s*$/gim;

export type AcGateResult =
  | { ok: true; criteria: string[] }
  | { ok: false; reason: string };

/**
 * Decide whether an issue body carries machine-checkable acceptance criteria.
 * Port of `input_contract.validate`: there must be an `Acceptance criteria`
 * section containing at least one markdown checkbox.
 */
export function validateAcceptanceCriteria(body: string): AcGateResult {
  const match = AC_SECTION.exec(body || "");
  if (!match) {
    return { ok: false, reason: "no 'Acceptance criteria' section in the issue body" };
  }
  const section = match[1] ?? "";
  const criteria: string[] = [];
  let m: RegExpExecArray | null;
  CHECKBOX.lastIndex = 0;
  while ((m = CHECKBOX.exec(section)) !== null) {
    const text = (m[1] ?? "").trim();
    if (text) criteria.push(text);
  }
  if (criteria.length === 0) {
    return {
      ok: false,
      reason:
        "Acceptance criteria are not machine-checkable: no checkbox criteria " +
        "the Objective Gate could turn into runnable checks",
    };
  }
  return { ok: true, criteria };
}

// --- Input-Contract v2 (issue #1034) — TS mirror of input_contract.py ---------
//
// The TS queue entrance must enforce the SAME three v2 checks the Python gate got
// in #1026/#1057 — injection screening, duplicate-content detection, per-writer
// rate limits — with matching semantics. Divergence between the two gates silently
// reopens a security bypass, so every pattern, reason string, threshold, and the
// PARK-not-drop ordering below is a verbatim port of
// `agentrail/guardrails/policies/input_contract.py`. Feature-gated on
// `AGENTRAIL_QUEUE_GUARDRAILS_V2 === "1"` (default-OFF), mirroring
// `agentrail/afk/queue_store.py`.

// v2 check 1 — injection screening (heuristics + deny-list). Each entry is a
// case-insensitive regex plus the human-readable reason recorded on a reject; the
// FIRST match wins. Ported one-for-one from `_INJECTION_PATTERNS` in the Python
// policy (the `(?i)`/`(?im)` inline flags become the `i`/`im` JS flags). Narrow by
// design: it targets directives AIMED AT THE AGENT, not innocent mentions of
// "agent"/"secret"/"print" — the shared corpus's negative controls guard breadth.
const INJECTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bignore\s+(all\s+|any\s+)?(the\s+)?previous\s+instructions?\b/i,
    "prompt-injection: 'ignore previous instructions' override directive",
  ],
  [
    /\bdisregard\s+(your\s+|the\s+|all\s+)?(system\s+prompt|instructions?|objective\s+gate)\b/i,
    "prompt-injection: 'disregard system prompt / gate' directive",
  ],
  [
    /\byou\s+are\s+now\b.*\b(developer\s+mode|unrestricted|no\s+guardrails|dan)\b/i,
    "prompt-injection: role-reassignment / jailbreak ('you are now …')",
  ],
  [
    /\b(developer\s+mode|jailbreak|no\s+guardrails|without\s+(any\s+)?guardrails)\b/i,
    "prompt-injection: jailbreak / disable-guardrails directive",
  ],
  [
    /\bact\s+as\s+(an?\s+)?(unrestricted|uncensored|jailbroken)\b/i,
    "prompt-injection: 'act as an unrestricted agent' role directive",
  ],
  [
    /\bprint\b.*\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|[A-Z0-9_]*SECRET[A-Z0-9_]*|[A-Z0-9_]*TOKEN[A-Z0-9_]*|[A-Z0-9_]*API_?KEY[A-Z0-9_]*)\b/i,
    "prompt-injection: secret-exfiltration directive (print a credential / env secret)",
  ],
  [
    /\b(exfiltrate|leak|dump|reveal)\b.*\b(secret|credential|token|api[_ ]?key|\.env)\b/i,
    "prompt-injection: secret-exfiltration directive",
  ],
  [
    /\bcurl\b[^\n|]*\|\s*(bash|sh|zsh)\b/i,
    "prompt-injection: remote-code-execution pattern (curl … | bash)",
  ],
  [
    /\bwget\b[^\n|]*\|\s*(bash|sh|zsh)\b/i,
    "prompt-injection: remote-code-execution pattern (wget … | sh)",
  ],
  [
    /^\s*(system|assistant|developer)\s*:\s*.*\b(override|auto[- ]?approve|approve|bypass)\b/im,
    "prompt-injection: impersonated privileged role trying to override the approval gate",
  ],
  [
    /\b(override|bypass|skip|disable)\b.*\b(human\s+)?(approval|review)\s+(gate|step|process)?\b.*\b(auto[- ]?approve|do\s+not\s+ask)\b/i,
    "prompt-injection: directive to override the human approval / review gate",
  ],
  [
    /\b(merge|approve|auto[- ]?approve)\b.*\b(without|no|skip(ping)?)\s+review\b/i,
    "prompt-injection: directive to merge/approve without review",
  ],
];

/**
 * Screen an issue body for prompt-injection directives (pure). Port of
 * `screen_injection`: returns the human-readable rejection reason for the FIRST
 * matching pattern, or `null` when the body is clean. A positive screen is a hard
 * REJECT at the entrance (or a PARK when `injectionPark` is set) — a probe must
 * never become a runnable entry.
 */
export function screenInjection(issueBody: string): string | null {
  const body = issueBody || "";
  for (const [pattern, reason] of INJECTION_PATTERNS) {
    // Patterns are declared with `g`-free flags and used read-only, so there is no
    // shared lastIndex to reset (unlike CHECKBOX above).
    if (pattern.test(body)) return reason;
  }
  return null;
}

// v2 check 2 — content-hash near-duplicate detection. Port of `content_hash`:
// collapse whitespace runs + lowercase + trim, then sha256, so the SAME content
// under a DIFFERENT issue number (whose deterministic per-number id differs) still
// hashes identically and can be caught as a duplicate.
const WS_RUN = /\s+/g;

/** Deterministic sha256 of the normalised issue body (port of `content_hash`). */
export function contentHash(issueBody: string): string {
  const normalised = (issueBody || "").trim().toLowerCase().replace(WS_RUN, " ");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

// v2 check 3 — per-writer rate limits. Port of `WriterClass` + `_DEFAULT_RATE_LIMITS`.
export const WriterClass = {
  HUMAN_GITHUB: "human-github",
  EVAL_AUTOTICKET: "eval-autoticket",
  JACE: "jace",
} as const;
export type WriterClass = (typeof WriterClass)[keyof typeof WriterClass];

// Per-writer admissions allowed per ledger window before subsequent entries park.
// Verbatim thresholds from `_DEFAULT_RATE_LIMITS`.
const DEFAULT_RATE_LIMITS: Readonly<Record<WriterClass, number>> = {
  [WriterClass.HUMAN_GITHUB]: 30,
  [WriterClass.EVAL_AUTOTICKET]: 10,
  [WriterClass.JACE]: 20,
};

// The rate limit is per *window*, not per process-lifetime. The TS entrance holds
// one long-lived module `processLedger` (below), so without windowing its per-writer
// counts accumulate for the whole process uptime and a high-volume writer eventually
// parks every subsequent entry until a restart (issue #1113, mirrors the Python
// daemon's `QueueStore._ledger`). Time-bucketing fixes it: admissions are attributed
// to `floor(now / RATE_LIMIT_WINDOW_SECONDS)`; when the window rolls the previous
// window's counts are dropped so a writer within its per-window budget is always
// admitted. Default one hour; env-overridable (verbatim port of the Python
// `RATE_LIMIT_WINDOW_SECONDS` / `_default_window_seconds`).
export const RATE_LIMIT_WINDOW_SECONDS = 3600; // 1 hour
export const RATE_LIMIT_WINDOW_ENV = "AGENTRAIL_RATE_LIMIT_WINDOW_SECONDS";

function defaultWindowSeconds(): number {
  const raw = process.env[RATE_LIMIT_WINDOW_ENV];
  if (raw) {
    const val = Number.parseInt(raw, 10);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return RATE_LIMIT_WINDOW_SECONDS;
}

/**
 * Immutable record of what the entrance has admitted (port of `AdmissionLedger`).
 * Threaded through by the caller so this module keeps no mutable module state and
 * stays deterministic. Every mutating method returns a NEW ledger.
 */
export class AdmissionLedger {
  readonly seenHashes: ReadonlySet<string>;
  readonly writerCounts: ReadonlyMap<WriterClass, number>;
  readonly rateLimits: ReadonlyMap<WriterClass, number>;
  // The wall-clock rate-limit window the `writerCounts` belong to
  // (`floor(now / windowSeconds)`); `null` on a fresh ledger. Rolled by
  // `forWindow` so the counts never accumulate for the whole process uptime
  // (issue #1113, port of the Python `AdmissionLedger.window_bucket`).
  readonly windowBucket: number | null;

  constructor(opts?: {
    seenHashes?: ReadonlySet<string>;
    writerCounts?: ReadonlyMap<WriterClass, number>;
    rateLimits?: ReadonlyMap<WriterClass, number>;
    windowBucket?: number | null;
  }) {
    this.seenHashes = opts?.seenHashes ?? new Set<string>();
    this.writerCounts = opts?.writerCounts ?? new Map<WriterClass, number>();
    this.rateLimits = opts?.rateLimits ?? new Map<WriterClass, number>();
    this.windowBucket = opts?.windowBucket ?? null;
  }

  private limitFor(writer: WriterClass): number {
    const explicit = this.rateLimits.get(writer);
    return explicit !== undefined ? explicit : DEFAULT_RATE_LIMITS[writer];
  }

  /**
   * Return a ledger whose per-writer counts belong to time-window `bucket`. When
   * the window rolls (a newer bucket than the counts were recorded under) the
   * previous window's `writerCounts` are dropped, so a writer within its per-window
   * budget is admitted again — the fix for unbounded accumulation on the long-lived
   * process ledger (issue #1113). Returns `this` unchanged when the bucket matches
   * (a within-window call is a no-op, so identity-based assertions still hold).
   * Only counts are windowed: `seenHashes` are NOT reset (dedup is content
   * identity, not a rate). Port of the Python `AdmissionLedger.for_window`.
   */
  forWindow(bucket: number): AdmissionLedger {
    if (this.windowBucket === bucket) return this;
    return new AdmissionLedger({
      seenHashes: this.seenHashes,
      writerCounts: new Map<WriterClass, number>(), // reset counts on window roll
      rateLimits: this.rateLimits,
      windowBucket: bucket,
    });
  }

  /** True when this content hash has already been admitted (AC2). */
  hasContent(bodyHash: string): boolean {
    return this.seenHashes.has(bodyHash);
  }

  /**
   * True when `writer` has already used its whole admission budget (AC3). Checked
   * BEFORE recording this admission, so the (limit+1)-th entry is the first to park.
   */
  rateLimitExceeded(writer: WriterClass): boolean {
    return (this.writerCounts.get(writer) ?? 0) >= this.limitFor(writer);
  }

  /**
   * Return a NEW ledger noting one more admission by `writer` of this content.
   * Recorded only for entries that actually take a slot; a dup/rate-limit PARK
   * skips this so a parked writer never counts against itself twice.
   */
  recordAdmission(writer: WriterClass, bodyHash: string): AdmissionLedger {
    const seenHashes = new Set(this.seenHashes);
    seenHashes.add(bodyHash);
    const writerCounts = new Map(this.writerCounts);
    writerCounts.set(writer, (writerCounts.get(writer) ?? 0) + 1);
    return new AdmissionLedger({
      seenHashes,
      writerCounts,
      rateLimits: this.rateLimits,
      windowBucket: this.windowBucket, // stay in the same window when recording
    });
  }
}

// The default-OFF v2 feature flag. Mirrors `queue_store._v2_enabled`: only the
// exact value "1" turns the layer on, so an unset/empty env var (the production
// default) leaves TS intake byte-for-byte the legacy behaviour (rollout safety).
export const V2_FLAG = "AGENTRAIL_QUEUE_GUARDRAILS_V2";

function v2Enabled(): boolean {
  return process.env[V2_FLAG] === "1";
}

// Map the persisted `source` string to the rate-limit writer class. Verbatim from
// `queue_store._SOURCE_TO_WRITER` / `_writer_for_source` (defaults to human-github).
const SOURCE_TO_WRITER: Readonly<Record<string, WriterClass>> = {
  github: WriterClass.HUMAN_GITHUB,
  eval: WriterClass.EVAL_AUTOTICKET,
  jace: WriterClass.JACE,
};

export function writerForSource(source: string): WriterClass {
  return SOURCE_TO_WRITER[source] ?? WriterClass.HUMAN_GITHUB;
}

/**
 * The pure v2 verdict for one issue body — the TS analogue of
 * `input_contract.admit_to_queue` restricted to the v2 checks (the base AC gate is
 * still run by its own `validateAcceptanceCriteria`). Returns:
 *
 *  - `{ decision: "reject", reason }`  — kept OUT of the queue (an injection probe
 *    with `injectionPark` off). Never becomes an entry.
 *  - `{ decision: "park", reason }`    — a real entry, but PARKED for human review
 *    with a human-readable reason (injection with `injectionPark` on, duplicate
 *    content, or the writer over its rate limit). Never a silent drop.
 *  - `{ decision: "admit", ledger }`   — clean; carries the NEXT ledger to thread
 *    forward (content hash + writer count recorded).
 *
 * Order is security-first and matches the Python gate exactly: injection → dup →
 * rate-limit. Never throws — any unexpected error is converted to a PARK.
 */
export type V2Verdict =
  | { decision: "admit"; ledger: AdmissionLedger }
  | { decision: "park"; reason: string; ledger: AdmissionLedger }
  | { decision: "reject"; reason: string; ledger: AdmissionLedger };

export function screenV2(opts: {
  body: string;
  writer: WriterClass;
  ledger: AdmissionLedger;
  injectionPark: boolean;
  // Injectable wall clock (epoch seconds) + window length for deterministic tests;
  // both default to the live clock / env-configured window (issue #1113).
  nowSeconds?: number;
  windowSeconds?: number;
}): V2Verdict {
  const { body, writer, injectionPark } = opts;
  // Roll the rate-limit window BEFORE the stateful checks so per-writer counts are
  // scoped to the current wall-clock window, not the process's whole uptime (issue
  // #1113). The rolled ledger (counts reset when the window changed) flows through
  // the rate-limit check and `recordAdmission`, and is what a park/reject returns —
  // so the reset persists even when the first entry in a new window parks. Declared
  // outside the try so it is in scope for the never-throw catch below.
  const windowSeconds = opts.windowSeconds ?? defaultWindowSeconds();
  const nowSeconds = opts.nowSeconds ?? Date.now() / 1000;
  const ledger = opts.ledger.forWindow(Math.floor(nowSeconds / windowSeconds));
  try {
    // 1. Injection screen. Hard REJECT by default; PARK (not drop) when
    // `injectionPark` is set — the live entrance sets it so a legitimate
    // house-format issue that trips the heuristic is surfaced for a human. A
    // parked injection did not take a fresh slot, so it records no ledger budget.
    const injectionReason = screenInjection(body);
    if (injectionReason !== null) {
      if (injectionPark) {
        return {
          decision: "park",
          reason:
            `prompt-injection screen tripped (${injectionReason}) — ` +
            "parked for human review instead of dropped",
          ledger,
        };
      }
      return { decision: "reject", reason: injectionReason, ledger };
    }

    // (The base machine-checkable-AC gate — step 2 in Python — is run by the
    // caller via validateAcceptanceCriteria before this, so it is not repeated.)

    const bodyHash = contentHash(body);

    // 3. Duplicate-content near-dup detection → PARK (do not run twice). No
    // budget/hash recorded: a parked dup did not take a fresh slot.
    if (ledger.hasContent(bodyHash)) {
      return {
        decision: "park",
        reason:
          "duplicate content: an issue with identical content is already " +
          "in the queue — parked for human review instead of running twice",
        ledger,
      };
    }

    // 4. Per-writer rate limit → PARK subsequent entries for this writer.
    if (ledger.rateLimitExceeded(writer)) {
      return {
        decision: "park",
        reason:
          `rate limit: writer '${writer}' exceeded its admission ` +
          "limit for this window — parked for human review",
        ledger,
      };
    }

    // Clean: admit and record the admission in the ledger.
    return { decision: "admit", ledger: ledger.recordAdmission(writer, bodyHash) };
  } catch (exc) {
    // Never let a check kill the entrance: convert any failure into a PARK.
    return {
      decision: "park",
      reason: `input-contract check errored, parked for human review: ${String(exc)}`,
      ledger,
    };
  }
}

/**
 * The process-wide admission ledger for the TS queue entrance (AC2/AC3).
 *
 * The Python live loop holds one persistent ledger on its long-lived `QueueStore`
 * and threads it forward across enqueues. The TS entrance is a set of stateless
 * request handlers (the Next.js webhook route), so the equivalent persistent seam
 * is a module-level ledger, swapped for the ledger `screenV2` returns after each
 * admission. `enqueueGithubIssue` uses it by default; tests inject their own via
 * the `ledger` option to stay deterministic and isolated.
 */
let processLedger = new AdmissionLedger();

/** Reset the process ledger — test-only seam so suites don't leak state. */
export function __resetProcessLedger(): void {
  processLedger = new AdmissionLedger();
}

// --- dependency parsing -------------------------------------------------------

// "blocked by #5", "blocked-by: #5, #6", "depends on #7 and #8" — case
// insensitive, captures every #N after the keyword phrase on that line.
const BLOCKED_BY_PHRASE = /(?:blocked[\s-]?by|depends[\s-]?on)\b[^\n]*/gi;

/**
 * Parse the issue numbers this issue declares it is blocked by / depends on.
 * Returns a sorted, de-duplicated list (empty when there are no declarations).
 * This is what lets the queue know "what blocks what".
 */
export function parseBlockedBy(body: string): number[] {
  const out = new Set<number>();
  const text = body || "";
  let phrase: RegExpExecArray | null;
  BLOCKED_BY_PHRASE.lastIndex = 0;
  while ((phrase = BLOCKED_BY_PHRASE.exec(text)) !== null) {
    const refs = phrase[0].match(/#(\d+)/g) || [];
    for (const ref of refs) out.add(parseInt(ref.slice(1), 10));
  }
  return [...out].sort((a, b) => a - b);
}

// --- deterministic row id (matches queue_store._entry_uuid) -------------------

// RFC 4122 URL namespace — the same one Python's uuid.NAMESPACE_URL uses.
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** uuid5(NAMESPACE_URL, name) — deterministic, so the same issue maps to one row. */
function uuid5Url(name: string): string {
  const ns = Buffer.from(NAMESPACE_URL.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(Buffer.from(name, "utf8"))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The durable row id for a (workspace, source, externalId), matching Python. */
function entryId(workspaceId: string, source: string, externalId: string): string {
  return uuid5Url(`agentrail-queue:${workspaceId}:${source}:${externalId}`);
}

// --- workspace resolution -----------------------------------------------------

/**
 * Find the workspace whose enabled GitHub connector lists `repoFullName`
 * (`owner/name`) in its `config.repos`. Returns null when no workspace owns it.
 */
export async function findWorkspaceByRepo(
  repoFullName: string
): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT workspace_id
    FROM connectors
    WHERE provider = 'github'
      AND enabled = true
      AND config -> 'repos' @> ${JSON.stringify([repoFullName])}::jsonb
    LIMIT 1
  `)) as unknown as Array<{ workspace_id: string }>;
  const row = Array.from(rows)[0];
  return row ? row.workspace_id : null;
}

// --- enqueue ------------------------------------------------------------------

export type EnqueueResult =
  | {
      enqueued: true;
      id: string;
      state: "queued" | "parked";
      blockedBy: number[];
      // Present only when a v2 check PARKED the entry (injection/dup/rate-limit):
      // a human-readable reason for the park. Absent on a clean admit. The webhook
      // response contract does not read it (it only reads `id`), so surfacing it
      // here keeps that contract unchanged while making the park operator-visible.
      reason?: string;
      // #1274: the discriminable outcome the console github-webhook route needs
      // to decide whether to compose+post an alignment brief. Present, and
      // ALWAYS "awaiting_alignment", whenever alignment is required and
      // unconfirmed for this issue — REGARDLESS of whether THIS enqueue ALSO
      // parked the row for an unmet dependency (finding-1 fix, adversarial
      // review of #1274 PR ①: a dependency park must not silently skip
      // alignment, since `unparkDependents` releasing it later would
      // otherwise hand out a claimable row with NULL budget/model, never
      // aligned). Never present for a v2-guardrail park (injection/dup/
      // rate-limit) — that keeps its own reason and the alignment hold does
      // not run for it at all (there is no automatic unpark for a guardrail
      // park, so that interaction bug cannot occur the same way; out of this
      // fix's scope). The console route reads this field ALONE to decide
      // whether to compose+post the brief — it does NOT imply `state` just
      // changed: a dependency-parked row keeps its OWN "Waiting on #N"
      // `parkReason` in the DB even while this is set.
      parkedFor?: "awaiting_alignment";
    }
  | { enqueued: false; reason: string };

/**
 * Admit a GitHub issue into the durable queue. Runs the AC gate; on pass, inserts
 * a `queue_entries` row (tier 0, budget 2, state 'queued') with the deterministic
 * id so a re-delivery of the same issue dedupes (ON CONFLICT DO NOTHING).
 */
/**
 * Human-readable reason for a dependency park (issue #1239): the unmet blocker
 * issue numbers, comma-joined ("Waiting on #12, #14"). Distinct wording from
 * `formatParkReason`'s blockedBy-only FALLBACK in the console
 * (`apps/console/lib/work-vocabulary.ts`, "Blocked by #12 and #14") — that
 * fallback only renders when NO stored reason exists at all; once this reason is
 * persisted, it is preferred and this exact string is what a human sees.
 */
function formatWaitingOnReason(unmet: number[]): string {
  return `Waiting on ${unmet.map((n) => `#${n}`).join(", ")}`;
}

/**
 * A query executor compatible with both the module-level `db` and a
 * `db.transaction(async (tx) => …)` callback's `tx` — both expose the same
 * `.select().from().where()` builder this function calls, but drizzle's
 * concrete generic types for `db` vs `tx` are not mutually assignable, so
 * this is deliberately narrowed to just the one method actually used here.
 * Drizzle's own docs recommend a permissive shape for exactly this "reuse a
 * query function inside and outside a transaction" case (see "Reusing query
 * functions in and outside transactions", orm.drizzle.team) — `Pick<typeof
 * db, "select">` is the typed version of that same idiom.
 * {@link confirmAlignmentBrief} below is the caller that needs the `tx`
 * variant: it must read this INSIDE its own transaction so the
 * read-then-write stays atomic (#1274 finding-1 fix).
 */
type QueryExecutor = Pick<typeof db, "select">;

/**
 * Of the declared blockers, return those NOT yet satisfied — i.e. issues in the
 * same repo that have a queue entry which has not reached the terminal `green`
 * state. A blocker with no entry yet is treated as unmet (it may arrive later);
 * the dependent stays parked until every blocker is green.
 */
async function unmetBlockers(
  exec: QueryExecutor,
  workspaceId: string,
  repoFullName: string,
  blockedBy: number[]
): Promise<number[]> {
  if (blockedBy.length === 0) return [];
  const blockerIds = blockedBy.map((n) => `${repoFullName}#${n}`);
  const greenRows = await exec
    .select({ externalId: queueEntries.externalId })
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.workspaceId, workspaceId),
        inArray(queueEntries.externalId, blockerIds),
        eq(queueEntries.state, "green")
      )
    );
  const greenNumbers = new Set(
    greenRows.map((r) => Number(r.externalId.split("#").pop()))
  );
  return blockedBy.filter((n) => !greenNumbers.has(n));
}

/**
 * After an entry reaches `green`, release any parked entries that were
 * waiting on it — SUBJECT TO ALIGNMENT (#1274 finding-1 fix; the alignment
 * gate itself is defined further down this file, in the "alignment gate"
 * section — `unparkDependents` stays here, next to `unmetBlockers`, since it
 * is fundamentally dependency machinery that now also happens to be
 * alignment-aware).
 *
 * THE BUG THIS CLOSES: `enqueueGithubIssue`'s alignment hold used to run
 * `if (state === "queued")` — an issue admitted with an unmet "Blocked by
 * #N" never reached that check at all, so it carried no brief and no
 * approval row. This function then unconditionally flipped ANY resolved
 * dependency park to `queued` once its blocker went green — handing the
 * runner a claimable row with NULL `estimated_budget_usd`/`model_override`,
 * never aligned. `enqueueGithubIssue` now signals the need for a brief
 * (`parkedFor: "awaiting_alignment"`) independently of the dependency
 * outcome (see that function's own comment); this is the release-side half
 * of the fix — a resolved dependency alone must never be enough to unpark.
 *
 * For each parked dependent whose declared blockers are now ALL green:
 *  - a DENIED entry (`parkReason` is {@link ALIGNMENT_DENIED_PARK_REASON})
 *    is left completely untouched — a denial is a STRONGER hold than a
 *    resolved dependency and must survive every future unpark attempt until
 *    PR ③'s revise flow replaces it (locked design point (c)).
 *  - otherwise, alignment is re-checked exactly as admission would: NOT
 *    `workspace.requireAlignment`, OR `kind !== 'issue'`, OR this row's own
 *    brief is already confirmed. Aligned -> flips to `queued` (the
 *    pre-existing behaviour, byte-identical when alignment was never in the
 *    picture). NOT aligned -> the park reason flips to
 *    {@link ALIGNMENT_PARK_REASON} — the brief already exists from
 *    admission, so there is nothing left to (re)post here; this just
 *    replaces the now-stale "Waiting on #N" with the TRUE reason the row is
 *    still stuck.
 *
 * Returns the external_ids ACTUALLY unparked (flipped to `queued`) — a
 * dependency-clear-but-not-yet-aligned entry is NOT included (it stayed
 * parked, just with an updated reason). Safe to call for any completed
 * entry.
 */
export async function unparkDependents(
  workspaceId: string,
  completedExternalId: string
): Promise<string[]> {
  const hash = completedExternalId.lastIndexOf("#");
  if (hash < 0) return [];
  const repoFullName = completedExternalId.slice(0, hash);
  const completedNumber = Number(completedExternalId.slice(hash + 1));
  if (!Number.isFinite(completedNumber)) return [];

  // Parked entries in this repo that list the completed issue as a blocker.
  // #1274: also reads kind/estimatedBudgetUsd/parkReason so the
  // alignment-release check below can decide without a second round trip
  // per entry.
  const parked = await db
    .select({
      externalId: queueEntries.externalId,
      blockedBy: queueEntries.blockedBy,
      kind: queueEntries.kind,
      estimatedBudgetUsd: queueEntries.estimatedBudgetUsd,
      parkReason: queueEntries.parkReason,
    })
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.workspaceId, workspaceId),
        eq(queueEntries.state, "parked"),
        sql`${queueEntries.blockedBy} @> ${JSON.stringify([completedNumber])}::jsonb`
      )
    );
  if (parked.length === 0) return [];

  // Fixed for this whole call (every row in `parked` shares one
  // workspaceId) — hoisted out of the loop rather than re-fetched per entry.
  const requireAlignment = await workspaceRequiresAlignment(workspaceId);

  const released: string[] = [];
  for (const entry of parked) {
    // A denial always wins — never overwritten by a resolved dependency.
    if (entry.parkReason === ALIGNMENT_DENIED_PARK_REASON) continue;

    const blockers = (entry.blockedBy ?? []) as number[];
    const stillUnmet = await unmetBlockers(db, workspaceId, repoFullName, blockers);
    // Still blocked: parkReason is left exactly as-is, matching this
    // function's pre-#1274 behaviour (it never refreshed a partially-
    // shrunk "Waiting on #N, #M" list either — out of this fix's scope).
    if (stillUnmet.length > 0) continue;

    // Every declared blocker is now green. `estimated_budget_usd IS NOT
    // NULL` is the ONLY "confirmed" marker used here — deliberately NOT
    // "an APPROVED jace_approvals row with queue_entry_id = entry.id" (the
    // other marker locked design point (c) offered): confirmAlignmentBrief
    // (below) always ATTEMPTS to write this column on approve, but the
    // Telegram webhook's applyAlignmentDecision can flip the approval to
    // 'approved' (via resolveApproval) and then bail BEFORE ever calling
    // confirmAlignmentBrief — a malformed stored toolInput, see
    // extractConfirmedBudgetAndModel's call site. In that failure mode an
    // "approved row exists" check would read true while no ceiling was
    // ever actually set, which would let release bypass the very ceiling
    // this gate exists to enforce — reintroducing a narrower version of the
    // exact bug this fix closes. `estimatedBudgetUsd` IS the enforced
    // ceiling itself (owner rule: "confirming the brief = sanctioning the
    // ceiling"), so it cannot be true without the ceiling genuinely
    // existing — the only marker that is safe to gate release on.
    const aligned =
      entry.kind !== "issue" ||
      entry.estimatedBudgetUsd !== null ||
      !requireAlignment;

    if (aligned) {
      await db
        .update(queueEntries)
        .set({ state: "queued", parkReason: null, updatedAt: new Date() })
        .where(
          and(
            eq(queueEntries.workspaceId, workspaceId),
            eq(queueEntries.externalId, entry.externalId),
            eq(queueEntries.state, "parked")
          )
        );
      released.push(entry.externalId);
    } else {
      // Dependency satisfied, alignment isn't: the brief already exists
      // from admission time — nothing to (re)post, just make the stored
      // reason honest instead of the now-stale "Waiting on #N".
      await db
        .update(queueEntries)
        .set({ parkReason: ALIGNMENT_PARK_REASON, updatedAt: new Date() })
        .where(
          and(
            eq(queueEntries.workspaceId, workspaceId),
            eq(queueEntries.externalId, entry.externalId),
            eq(queueEntries.state, "parked")
          )
        );
    }
  }
  return released;
}

// --- alignment gate (#1274) ----------------------------------------------------
//
// "Before ANY queue entry executes, Jace posts an alignment brief and the
// entry holds parked until confirmed" (recon annex, owner ACs). This is the
// admission-time half: enqueueGithubIssue holds a clean-admit row parked
// instead of queued so the console github-webhook route can compose+post the
// brief; confirmAlignmentBrief/denyAlignmentBrief below are the OTHER half
// (the webhook's confirm/deny side-effect once a human answers).

/**
 * Canonical GitHub issue URL, matching GitHub's own `html_url` shape
 * (`https://github.com/<owner>/<repo>/issues/<number>`). SINGLE SOURCE OF
 * TRUTH: {@link hasConfirmedAlignmentBrief} below reads this exact shape back
 * out of `jace_approvals.published_issue_url`, and the console route composing
 * the brief imports this same function for the `issueUrl` it stores on the
 * approval's `toolInput` — so the two sides can never drift on formatting.
 * ASSUMPTION (documented, not yet exercised): PR ②'s chat-born stamping is
 * expected to persist the real GitHub API `html_url` verbatim, which is this
 * exact shape.
 */
export function githubIssueUrl(repoFullName: string, number: number): string {
  return `https://github.com/${repoFullName}/issues/${number}`;
}

/** Read a workspace's `require_alignment` flag. Defaults to `true` (the spec default, and this column's own NOT NULL DEFAULT) if the workspace row is somehow missing — fails toward the safer "still gate" direction rather than silently admitting unaligned work. No `.limit()` — matches `unmetBlockers`'s own chain shape in this file (a plain `.select().from().where()` awaited directly), since `workspace_id` is already unique. */
async function workspaceRequiresAlignment(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ requireAlignment: workspaces.requireAlignment })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return rows[0]?.requireAlignment ?? true;
}

/**
 * Has this issue already been through a CONFIRMED alignment brief, IN THIS
 * WORKSPACE? The lookup: an `approved` `jace_approvals` row SCOPED TO
 * `workspaceId` whose `published_issue_url` matches this issue's URL
 * exactly.
 *
 * Workspace-scoped (adversarial review finding 3 of #1274 PR ①): the
 * original version of this lookup matched on `(status, publishedIssueUrl)`
 * alone, with no tenant boundary at all — an approval recorded in workspace
 * A could satisfy this lookup for workspace B. `jace_approvals.workspace_id`
 * is already a direct column on the table (no join needed — mirrors
 * `findApprovalByCallbackToken` in `jace_sessions.ts`, the same
 * direct-column idiom), so adding `eq(jaceApprovals.workspaceId,
 * workspaceId)` closes it with one extra `and()` clause.
 *
 * Nothing populates `publishedIssueUrl` for an `alignment_brief` approval
 * yet — PR ②'s chat-born one-confirm collapse is what will start stamping it
 * once a `create_issue` approval's resulting issue is known — so this always
 * returns `false` today. That is the CORRECT direction to fail in until PR ②
 * lands: a chat-born issue re-delivered through the label-webhook path parks
 * for a second (redundant, but safe) confirm rather than silently skipping
 * alignment.
 */
async function hasConfirmedAlignmentBrief(
  workspaceId: string,
  issueUrl: string
): Promise<boolean> {
  const rows = await db
    .select({ id: jaceApprovals.id })
    .from(jaceApprovals)
    .where(
      and(
        eq(jaceApprovals.workspaceId, workspaceId),
        eq(jaceApprovals.status, "approved"),
        eq(jaceApprovals.publishedIssueUrl, issueUrl)
      )
    );
  return rows.length > 0;
}

/**
 * The exact, house-format park reason vocabulary the alignment hold writes.
 * `apps/console/lib/work-vocabulary.ts::formatParkReason` renders the STORED
 * reason verbatim (issue #1239), so this literal string IS what a human sees
 * on the console Work board — changing it here changes displayed copy.
 */
export const ALIGNMENT_PARK_REASON = "awaiting alignment";

/**
 * The exact `parkReason` a denied alignment brief carries — named the same
 * way {@link ALIGNMENT_PARK_REASON} is (a house-format-rendered, verbatim
 * string) so both the writer ({@link denyAlignmentBrief}) and the reader
 * that must never overwrite it ({@link unparkDependents}) single-source the
 * comparison. Extracted as a constant during the #1274 finding-1 fix review
 * (it was previously an inline literal only `denyAlignmentBrief` wrote —
 * `unparkDependents` now also needs to RECOGNIZE it).
 */
export const ALIGNMENT_DENIED_PARK_REASON =
  "alignment denied — ask Jace to revise the brief";

/**
 * Atomically confirm a parked alignment hold and write the two #1333
 * threading columns — this write IS what activates that dormant plumbing
 * (owner rule: "confirming the brief = sanctioning the ceiling"; the values
 * exist ONLY from this point on, never before, REGARDLESS of the resulting
 * `state` below).
 *
 * #1274 finding-1 fix (locked design point (b)): confirming no longer
 * unconditionally flips `parked` -> `queued`. A brief can now be posted
 * while its row sits DEPENDENCY-parked (see `enqueueGithubIssue`'s
 * `parkedFor` signal firing independently of the dependency outcome), so
 * confirming it must not silently skip that still-unmet blocker. This
 * re-derives the blocker state from the row's own `blockedBy` at confirm
 * time and picks the resulting `state`/`parkReason` accordingly:
 *   - no blockers declared, or all green -> `state: 'queued'`, `parkReason: null`
 *     (the pre-#1274 behaviour, byte-identical when dependency was never a
 *     factor).
 *   - blockers still unmet -> stays `state: 'parked'` with the DEPENDENCY
 *     reason (`formatWaitingOnReason`) — NOT `ALIGNMENT_PARK_REASON`: the
 *     brief is now answered, so the TRUE reason the row is still stuck is
 *     the dependency, and `unparkDependents` will take it from here once
 *     the blocker clears (reading the now-non-null `estimatedBudgetUsd` as
 *     its "aligned" signal).
 *
 * Read-then-write in ONE `db.transaction` (locked design point (b)'s
 * "two-step within the same statement/tx" option) rather than a single raw
 * UPDATE with an embedded CASE: the blocker recheck reuses the exact same
 * `unmetBlockers` logic `enqueueGithubIssue`/`unparkDependents` already use
 * (single source of truth for "what counts as unmet"), which a hand-rolled
 * SQL CASE/subquery would have to reimplement and could drift from.
 *
 * The final UPDATE keeps the SAME `WHERE state = 'parked'` belt-and-
 * suspenders idempotency guard the pre-#1274 version used (see the original
 * doc-comment's rationale, preserved): the CALLER (the Telegram webhook's
 * `handleApprovalCallback`) already gates this on `resolveApproval`'s own
 * atomic pending->approved flip, so a double-tap never reaches this function
 * twice; the WHERE clause guards the (still theoretical) case where the row
 * left `parked` some other way between the approval being recorded and
 * being resolved. Returns `false` (no-op, never throws) when either the
 * initial read or the final write matches zero rows.
 */
export async function confirmAlignmentBrief(input: {
  queueEntryId: string;
  estimatedBudgetUsd: number;
  modelOverride: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        workspaceId: queueEntries.workspaceId,
        externalId: queueEntries.externalId,
        blockedBy: queueEntries.blockedBy,
      })
      .from(queueEntries)
      .where(
        and(
          eq(queueEntries.id, input.queueEntryId),
          eq(queueEntries.state, "parked")
        )
      );
    const row = rows[0];
    if (!row) return false;

    const blockedBy = (row.blockedBy ?? []) as number[];
    const hash = row.externalId.lastIndexOf("#");
    const repoFullName = hash >= 0 ? row.externalId.slice(0, hash) : row.externalId;
    const unmet = await unmetBlockers(tx, row.workspaceId, repoFullName, blockedBy);

    const result = await tx
      .update(queueEntries)
      .set({
        state: unmet.length === 0 ? "queued" : "parked",
        parkReason: unmet.length === 0 ? null : formatWaitingOnReason(unmet),
        estimatedBudgetUsd: input.estimatedBudgetUsd,
        modelOverride: input.modelOverride,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(queueEntries.id, input.queueEntryId),
          eq(queueEntries.state, "parked")
        )
      )
      .returning({ id: queueEntries.id });
    return result.length > 0;
  });
}

/**
 * Alignment-brief denial: the entry STAYS parked (revise flow is PR ③), only
 * `parkReason` changes to {@link ALIGNMENT_DENIED_PARK_REASON} — never a
 * silent no-op and never a state flip. Same `WHERE state = 'parked'` shape as
 * {@link confirmAlignmentBrief}'s final write; see that function's
 * doc-comment for why. The denial reason WINS over a dependency reason
 * (locked design point (b)) simply by unconditionally overwriting whatever
 * `parkReason` currently holds; {@link unparkDependents} is what makes this
 * stick going forward — it recognizes this exact string and refuses to ever
 * touch a row carrying it, so a later-resolved dependency can never
 * overwrite a denial.
 */
export async function denyAlignmentBrief(queueEntryId: string): Promise<boolean> {
  const result = await db
    .update(queueEntries)
    .set({
      parkReason: ALIGNMENT_DENIED_PARK_REASON,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(queueEntries.id, queueEntryId),
        eq(queueEntries.state, "parked")
      )
    )
    .returning({ id: queueEntries.id });
  return result.length > 0;
}

/**
 * Outcome of a {@link requeueParkedQueueEntry} call — discriminated so the
 * console (#1276 PR ②) can show an honest, specific reason rather than a
 * bare boolean. `alignment_locked` is the load-bearing case: an alignment
 * hold (`ALIGNMENT_PARK_REASON`/`ALIGNMENT_DENIED_PARK_REASON`) resolves
 * EXCLUSIVELY through the posted brief's own Approve/Deny — a raw requeue
 * bypassing it would let unpriced work back onto the queue, reintroducing the
 * exact bug #1274 closed.
 */
export type RequeueParkedQueueEntryResult =
  | "requeued"
  | "not_found"
  | "not_parked"
  | "alignment_locked";

/**
 * Requeue a single parked `queue_entries` row for a guardrail (duplicate
 * content / rate limit / injection screen) or dependency ("Waiting on #N")
 * park — the console approvals page's Requeue action (#1276 PR ②).
 *
 * Read-then-write in ONE `db.transaction`, mirroring
 * {@link confirmAlignmentBrief}'s own rationale for that shape: the read
 * distinguishes WHY a requeue didn't happen (not found / wrong workspace /
 * not currently parked / alignment-locked) so the caller can render a
 * specific, honest reason instead of a bare no-op — while the actual
 * enforcement is the final UPDATE's own `WHERE` clause, not the read (never
 * trust a pre-check alone for a security property, the same posture
 * `resolveApproval`/`requeueDeadChannelMessage` take with their guarded
 * `WHERE`). Workspace-scoped: `id` alone is never enough (an id from another
 * workspace resolves `not_found`, matching `getApiKey`'s scoped-lookup
 * idiom elsewhere in this package).
 */
export async function requeueParkedQueueEntry(
  workspaceId: string,
  id: string
): Promise<RequeueParkedQueueEntryResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ state: queueEntries.state, parkReason: queueEntries.parkReason })
      .from(queueEntries)
      .where(and(eq(queueEntries.id, id), eq(queueEntries.workspaceId, workspaceId)));
    const row = rows[0];
    if (!row) return "not_found";
    if (row.state !== "parked") return "not_parked";
    if (
      row.parkReason === ALIGNMENT_PARK_REASON ||
      row.parkReason === ALIGNMENT_DENIED_PARK_REASON
    ) {
      return "alignment_locked";
    }

    const result = await tx
      .update(queueEntries)
      .set({ state: "queued", parkReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(queueEntries.id, id),
          eq(queueEntries.workspaceId, workspaceId),
          eq(queueEntries.state, "parked"),
          // Belt-and-suspenders (matches this function's own doc-comment):
          // the actual gate is HERE, not the read above.
          sql`${queueEntries.parkReason} IS DISTINCT FROM ${ALIGNMENT_PARK_REASON}`,
          sql`${queueEntries.parkReason} IS DISTINCT FROM ${ALIGNMENT_DENIED_PARK_REASON}`
        )
      )
      .returning({ id: queueEntries.id });
    return result.length > 0 ? "requeued" : "not_parked";
  });
}

export async function enqueueGithubIssue(data: {
  workspaceId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
  // Test-only: inject a ledger so a suite can exercise the stateful v2 checks
  // (dup / rate-limit) deterministically. Production uses the process ledger.
  ledger?: AdmissionLedger;
  // Test-only: inject the wall clock (epoch seconds) so a suite can drive the
  // rate-limit window across a boundary deterministically (issue #1113).
  nowSeconds?: number;
}): Promise<EnqueueResult> {
  const gate = validateAcceptanceCriteria(data.body);
  if (!gate.ok) return { enqueued: false, reason: gate.reason };

  const externalId = `${data.repoFullName}#${data.number}`;
  const id = entryId(data.workspaceId, "github", externalId);

  // Dependency awareness: declared blockers that aren't green yet park the
  // entry so the runner never claims it (claim only grabs `queued`). When the
  // last blocker goes green, recordRunnerResult unparks it.
  const blockedBy = parseBlockedBy(data.body);
  const unmet = await unmetBlockers(db, data.workspaceId, data.repoFullName, blockedBy);
  let state: "queued" | "parked" = unmet.length > 0 ? "parked" : "queued";
  let reason: string | undefined;
  // Issue #1239: the durable, human-readable park reason persisted on the row
  // (distinct from `reason` above, which only rides the enqueue HTTP response).
  // Seeded from the dependency park when that's why the entry parked; a v2
  // guardrail park below overrides it with its own reason when BOTH fire (v2
  // check order is security-first — see `screenV2` — so a guardrail park always
  // wins when both a guardrail and a dependency would park the same entry).
  let parkReason: string | null = state === "parked" ? formatWaitingOnReason(unmet) : null;

  // Input-Contract v2 (issue #1034), default-OFF behind V2_FLAG so the legacy
  // path is byte-for-byte unchanged until the flag is turned on. When enabled we
  // thread the process ledger through the SAME three checks the Python gate runs
  // (injection / duplicate content / per-writer rate limit) with matching
  // semantics. `injectionPark` is on at this live entrance (mirrors the Python
  // live loop): a positive check PARKS the entry for human review — it is never a
  // silent drop — so a gated-out enqueue still returns `enqueued: true` with a
  // reason, keeping the webhook response contract unchanged (AC3).
  const usingV2 = v2Enabled();
  // Tracks ONLY a v2 guardrail park (injection/dup/rate-limit) — distinct
  // from `state === "parked"`, which a dependency park (above) can ALSO have
  // already set. The alignment gate below needs this specific distinction
  // (finding-1 fix): it must still run for a dependency park, just never for
  // a v2-guardrail park.
  let v2Parked = false;
  if (usingV2) {
    const ledgerIn = data.ledger ?? processLedger;
    const verdict = screenV2({
      body: data.body,
      writer: writerForSource("github"),
      ledger: ledgerIn,
      injectionPark: true,
      nowSeconds: data.nowSeconds,
    });
    if (verdict.decision === "reject") {
      // Injection with injectionPark off never reaches here (it is on at this
      // entrance); keep the legacy contract of no row for an un-admittable issue.
      return { enqueued: false, reason: verdict.reason };
    }
    if (verdict.decision === "park") {
      state = "parked";
      reason = verdict.reason;
      parkReason = verdict.reason;
      v2Parked = true;
    }
    // Only thread the ledger forward for the shared process ledger; a test-injected
    // ledger is owned by the caller (mirrors Python threading `admission.ledger`).
    if (data.ledger === undefined) processLedger = verdict.ledger;
  }

  // Alignment gate (#1274, locked design point 3; finding-1 fix from the
  // adversarial review of PR ①): evaluated INDEPENDENTLY of the dependency
  // outcome above — a dependency park must NOT skip alignment the way a
  // v2-guardrail park still does (there is no automatic unpark for a
  // guardrail park, so releasing one without ever having alignment-checked
  // it isn't reachable the same way; that path is unchanged and out of this
  // fix's scope — `v2Parked` short-circuits the gate below exactly like the
  // old `state === "queued"` check did for it).
  //
  // Whenever alignment IS required and unconfirmed: `parkedFor` is ALWAYS
  // set, so the console webhook route composes+posts the brief. But the
  // STORED `state`/`parkReason` only change when the row would otherwise
  // have gone `queued` clean — a dependency-parked row KEEPS its own
  // "Waiting on #N" reason (the more specific, currently-true reason a human
  // should see on the console Work board); `unparkDependents` re-checks
  // alignment before ever releasing such a row to `queued` (see that
  // function's own doc-comment for the release-side half of this fix).
  //
  // `kind` here is always 'issue' by construction — this function never
  // inserts any other kind (see `enqueueOnboard` below, which never routes
  // through this check at all: requireAlignment=true never parks an onboard
  // row, regression-pinned).
  let parkedFor: "awaiting_alignment" | undefined;
  if (!v2Parked) {
    const requireAlignment = await workspaceRequiresAlignment(data.workspaceId);
    if (requireAlignment) {
      const issueUrl = githubIssueUrl(data.repoFullName, data.number);
      const confirmed = await hasConfirmedAlignmentBrief(data.workspaceId, issueUrl);
      if (!confirmed) {
        parkedFor = "awaiting_alignment";
        if (state === "queued") {
          state = "parked";
          parkReason = ALIGNMENT_PARK_REASON;
        }
        // else: already dependency-parked — `parkReason` stays exactly what
        // the dependency check above set ("Waiting on #N, #M"); `parkedFor`
        // alone is what tells the console route to compose+post the brief
        // while the row sits parked for the dependency reason.
      }
    }
  }

  const inserted = await db
    .insert(queueEntries)
    .values({
      id,
      workspaceId: data.workspaceId,
      source: "github",
      externalId,
      title: data.title,
      body: data.body,
      tier: 0,
      // Bounded retry budget: one unit per red/error attempt before escalating
      // to a human (#890 "retry on error max 5 times"). Matches the column default.
      remainingBudget: 5,
      state,
      blockedBy,
      parkReason,
    })
    .onConflictDoNothing({ target: queueEntries.id })
    .returning({ id: queueEntries.id });

  if (inserted.length === 0) {
    return { enqueued: false, reason: "already queued (deduped)" };
  }
  // A v2 park (dup/rate-limit/injection) or a dependency park still enqueues a
  // durable row so a human can review it — the row records state='parked' AND
  // (issue #1239) the human-readable `parkReason`, so a later read (the console
  // Work page) can show WHY without needing this response. `reason` below is a
  // separate, response-only field: it only ever carries a v2 guardrail reason
  // (never the dependency-park reason), keeping the webhook response contract
  // unchanged from before #1239. `parkedFor` is the #1274 discriminant the
  // console github-webhook route reads to decide whether to compose+post an
  // alignment brief — independent of `reason` (`reason` is v2-only,
  // `parkedFor` is alignment-only). Unlike before the finding-1 fix, these
  // two CAN now coexist with `state === "parked"` for a dependency reason:
  // `parkedFor` says "the console still needs to post a brief", not "this
  // enqueue was otherwise clean" — see the alignment-gate block above and
  // `EnqueueResult.parkedFor`'s own doc-comment for the full picture.
  return {
    enqueued: true,
    id,
    state,
    blockedBy,
    ...(reason !== undefined ? { reason } : {}),
    ...(parkedFor !== undefined ? { parkedFor } : {}),
  };
}

/**
 * The external-id prefix that marks a queue entry as an onboard job
 * (`onboard:<owner/name>`). SINGLE SOURCE OF TRUTH (#1268 PR②): the writer
 * (`enqueueOnboard` below), the claim-side reader (`deriveRepoSlug` in
 * runner.ts), and the console's completion-notify reader
 * (`onboardRepoFullName` in the result route) all import THIS constant, so
 * the prefix a row is written with can never drift from the prefix its
 * readers route on. Change it here and every site follows; the round-trip
 * test in the console suite (real enqueueOnboard → onboardRepoFullName)
 * additionally pins that the composed pair keeps agreeing.
 */
export const ONBOARD_EXTERNAL_ID_PREFIX = "onboard:";

/**
 * Admit a one-shot `onboard` job into the durable queue for a freshly connected
 * repo. Unlike an issue, this carries no AC gate, no blockers, and no v2 screen —
 * it is workspace-owned indexing work, not user-authored content. The runner
 * claims it (kind='onboard'), clones the repo at its default branch, builds the
 * context index, and seeds a handful of workspace memory items.
 *
 * Idempotency is the whole point: the row id is `entryId(workspaceId, 'github',
 * 'onboard:<repoFullName>')`, so re-connecting the same repo (or a double webhook
 * / double click) maps to the SAME row and `ON CONFLICT DO NOTHING` makes the
 * second call a no-op. Exactly one onboard per repo, forever — the caller can fire
 * it on every connect without guarding.
 */
export async function enqueueOnboard(data: {
  workspaceId: string;
  repoFullName: string;
}): Promise<EnqueueResult> {
  // The onboard externalId is repo-scoped (not issue-scoped) so there is one
  // durable onboard row per repo. `deriveRepoSlug` (claim side) reads the repo
  // slug back off this same `onboard:<owner/name>` shape.
  const externalId = `${ONBOARD_EXTERNAL_ID_PREFIX}${data.repoFullName}`;
  const id = entryId(data.workspaceId, "github", externalId);

  const inserted = await db
    .insert(queueEntries)
    .values({
      id,
      workspaceId: data.workspaceId,
      source: "github",
      kind: "onboard",
      externalId,
      title: `Onboard ${data.repoFullName}`,
      body: "",
      tier: 0,
      // Onboarding is best-effort — cap at 3 attempts. Unlike an issue run, a
      // bigger model/tier can't fix a clone/index failure, so extra retries only
      // burn budget without changing the outcome.
      remainingBudget: 3,
      state: "queued",
      blockedBy: [],
    })
    .onConflictDoNothing({ target: queueEntries.id })
    .returning({ id: queueEntries.id });

  if (inserted.length === 0) {
    return { enqueued: false, reason: "already onboarded (deduped)" };
  }
  return { enqueued: true, id, state: "queued", blockedBy: [] };
}
