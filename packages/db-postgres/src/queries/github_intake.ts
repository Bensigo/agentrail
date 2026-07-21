import { createHash } from "crypto";
import { sql, and, eq, inArray, isNull } from "drizzle-orm";
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
 * {@link requeueParkedQueueEntry} below is the caller that needs the `tx`
 * variant: it must read this INSIDE its own transaction so the
 * read-then-write stays atomic. ({@link confirmAlignmentBrief} used to be a
 * `tx` caller too, pre-#1341 — that function is now a single raw UPDATE with
 * the blocker recheck inlined as a SQL subquery instead, precisely so it no
 * longer needs a read-then-write transaction at all; see its own doc-comment.)
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
  const requireAlignment = await workspaceRequiresAlignment(db, workspaceId);

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
      //
      // #1341 belt-and-suspenders: `entry.estimatedBudgetUsd` above came from
      // the batch SELECT at the top of this function — by the time this
      // statement actually runs, `confirmAlignmentBrief` (now a single atomic
      // UPDATE, see its own #1341 doc-comment) may have ALREADY committed a
      // budget for this exact row using a fresher read. Without the extra
      // `estimated_budget_usd IS NULL` guard below, this UPDATE would re-stamp
      // "awaiting alignment" over a row that just got genuinely sanctioned —
      // stale parkReason wedged next to a real budget, one of the two
      // #1341-closed wedge shapes. The guard makes THIS write a no-op the
      // instant that happens (0 rows matched), same idempotent-WHERE posture
      // every parked-row write in this file already takes.
      await db
        .update(queueEntries)
        .set({ parkReason: ALIGNMENT_PARK_REASON, updatedAt: new Date() })
        .where(
          and(
            eq(queueEntries.workspaceId, workspaceId),
            eq(queueEntries.externalId, entry.externalId),
            eq(queueEntries.state, "parked"),
            isNull(queueEntries.estimatedBudgetUsd)
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
 * TRUTH: {@link findConfirmedAlignmentBriefApproval} below reads this exact shape back
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

/** Read a workspace's `require_alignment` flag. Defaults to `true` (the spec default, and this column's own NOT NULL DEFAULT) if the workspace row is somehow missing — fails toward the safer "still gate" direction rather than silently admitting unaligned work. No `.limit()` — matches `unmetBlockers`'s own chain shape in this file (a plain `.select().from().where()` awaited directly), since `workspace_id` is already unique. Takes a `QueryExecutor` (same idiom as `unmetBlockers`) so `requeueParkedQueueEntry` can read it INSIDE its own transaction; plain callers pass `db`. */
async function workspaceRequiresAlignment(
  exec: QueryExecutor,
  workspaceId: string
): Promise<boolean> {
  const rows = await exec
    .select({ requireAlignment: workspaces.requireAlignment })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return rows[0]?.requireAlignment ?? true;
}

/**
 * Has this issue already been through a CONFIRMED alignment brief, IN THIS
 * WORKSPACE — and if so, return the MATCHED approval's `toolInput` (#1274
 * PR ②) so the caller can pull the sanctioned budget/model out of it. The
 * lookup: an `approved` `jace_approvals` row SCOPED TO `workspaceId` whose
 * `published_issue_url` matches this issue's URL EXACTLY (full string
 * equality on `https://github.com/<owner>/<repo>/issues/<n>` —
 * host+owner+repo+number, never a substring/fragment match, and NEVER
 * derived from the issue's title — see {@link githubIssueUrl}, which this
 * function's caller computes `issueUrl` from and which never accepts a
 * title in the first place. A crafted issue title containing what LOOKS
 * like a GitHub issue URL therefore has zero effect on this lookup: the
 * compared value is always server-computed from `repoFullName`+`number`
 * alone, on both the write side — PR ②'s stamp endpoint additionally
 * regex-validates the shape of any url it ever writes, see
 * `apps/console/app/api/v1/runner/approvals/[id]/published/route.ts` — and
 * this read side).
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
 * Renamed from the PR ① boolean-returning `hasConfirmedAlignmentBrief`:
 * PR ②'s `apps/jace/agent/lib/create_issue.core.mjs` now stamps
 * `published_issue_url` (via the new `/published` endpoint) once a
 * `create_issue` approval's resulting issue is known, so this can start
 * matching in practice — and once it does, `enqueueGithubIssue` needs the
 * matched row's `toolInput` (specifically its `_brief`, see
 * `extractBriefBudgetAndModel` below), not just a boolean.
 *
 * `toolName = 'create_issue'` (#1274 PR ② fix round, finding I1): ONLY a
 * create_issue approval can confirm via URL match. An `alignment_brief`
 * approval sanctions its work-item through `queue_entry_id` ->
 * `confirmAlignmentBrief` (values written directly on the parked row); it
 * never legitimately carries `published_issue_url` — and no other tool's
 * approval (create_workspace/create_repo) is about an issue at all.
 * Without this filter, a stale APPROVED row of ANY tool, stamped with a
 * target issue's URL, would satisfy this lookup — and via the no-`_brief`
 * fallback below, admit that issue straight to `queued` with NO values and
 * NO human ever having confirmed THAT work. Belt-and-braces with the stamp
 * endpoint's own route-level create_issue-only refusal (the write side of
 * the same fix) — either alone closes the hole; both together mean neither
 * a bypassed route nor a future lookup caller can silently reopen it.
 */
async function findConfirmedAlignmentBriefApproval(
  workspaceId: string,
  issueUrl: string
): Promise<{ toolInput: Record<string, unknown> } | null> {
  const rows = await db
    .select({ toolInput: jaceApprovals.toolInput })
    .from(jaceApprovals)
    .where(
      and(
        eq(jaceApprovals.workspaceId, workspaceId),
        eq(jaceApprovals.status, "approved"),
        eq(jaceApprovals.toolName, "create_issue"),
        eq(jaceApprovals.publishedIssueUrl, issueUrl)
      )
    );
  return rows[0] ?? null;
}

/**
 * Extract the sanctioned budget/model from a MATCHED confirmed-brief
 * approval's own stored `toolInput._brief` (#1274 PR ②) — the console
 * approvals POST route's enrichment writes this reserved key onto a
 * `create_issue` approval's `toolInput` at record time (see
 * `apps/console/app/api/v1/runner/approvals/route.ts` and
 * `apps/console/lib/alignment-brief.ts::composeChatBornBrief`); this is the
 * db-postgres-side mirror of `extractConfirmedBudgetAndModel`
 * (`apps/console/lib/alignment-brief.ts`) — DELIBERATELY DUPLICATED rather
 * than imported (confirmed layering rule from #1274 PR ①'s own review: zero
 * db-postgres -> console-lib imports either direction) — same defensive
 * shape, `null` on anything malformed so the caller can fall back rather
 * than write a bogus budget/model.
 *
 * `null` when `_brief` is absent entirely — a PRE-#1274-PR② row (recorded
 * before this enrichment existed) that nonetheless got approved and later
 * stamped is a real, if narrow, deploy-ordering edge case (see
 * `enqueueGithubIssue`'s own comment on the caller side for how that case
 * is handled — the "no-`_brief` fallback restriction").
 *
 * #1338 PR①: also extracts `taskType` (the classifier's output,
 * `ChatBornBrief.taskType` on the console side) so `enqueueGithubIssue` can
 * denormalize it onto the newly-admitted row. Independent/non-gating: unlike
 * `estimateUsd`/`suggestedModel.slug`, a missing or malformed `taskType`
 * does NOT fail the whole extraction (this function still returns the
 * budget/model when they're valid) — it just yields `taskType: null`, since
 * a task type is a nice-to-have denormalization, not a load-bearing value
 * the brief-confirm flow depends on.
 */
function extractBriefBudgetAndModel(
  toolInput: Record<string, unknown>
): { estimatedBudgetUsd: number; modelOverride: string; taskType: string | null } | null {
  const brief = toolInput["_brief"];
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return null;
  const b = brief as Record<string, unknown>;

  const estimateUsd = b["estimateUsd"];
  if (typeof estimateUsd !== "number" || !Number.isFinite(estimateUsd)) return null;

  const suggestedModel = b["suggestedModel"];
  if (!suggestedModel || typeof suggestedModel !== "object" || Array.isArray(suggestedModel)) {
    return null;
  }
  const slug = (suggestedModel as Record<string, unknown>)["slug"];
  if (typeof slug !== "string" || slug.length === 0) return null;

  const taskTypeValue = b["taskType"];
  const taskType = typeof taskTypeValue === "string" && taskTypeValue.length > 0 ? taskTypeValue : null;

  return { estimatedBudgetUsd: estimateUsd, modelOverride: slug, taskType };
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
 *
 * #1274 PR③ deny-copy honesty pass: the original wording ("ask Jace to
 * revise the brief") promised a mechanism that does not exist — there is no
 * revise/re-brief flow (deliberately out of scope, tracked as a backlog
 * issue), and `requeueParkedQueueEntry` explicitly REFUSES a denied row
 * (returns `"alignment_locked"`, never requeues it) regardless of channel.
 * A denied entry's deterministic row id also means neither re-labeling nor
 * re-opening the SAME issue produces a new admission (`ON CONFLICT DO
 * NOTHING`). The one thing that genuinely works today: a DIFFERENT issue
 * (a new external id) gets a fresh row and a fresh brief — so the copy
 * points at that, the one true "try again" this product supports right now.
 * Single source of truth (update it here only — every consumer imports this
 * constant already; see this PR's report for the full grep).
 */
export const ALIGNMENT_DENIED_PARK_REASON =
  "alignment denied — open a new issue to try again";

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
 * re-derives the blocker state from the row's own `blockedBy` and picks the
 * resulting `state`/`parkReason` accordingly:
 *   - no blockers declared, or all green -> `state: 'queued'`, `parkReason: null`
 *     (the pre-#1274 behaviour, byte-identical when dependency was never a
 *     factor).
 *   - blockers still unmet -> stays `state: 'parked'` with the DEPENDENCY
 *     reason (`formatWaitingOnReason`-shaped, built in SQL below) — NOT
 *     `ALIGNMENT_PARK_REASON`: the brief is now answered, so the TRUE reason
 *     the row is still stuck is the dependency, and `unparkDependents` will
 *     take it from here once the blocker clears (reading the now-non-null
 *     `estimatedBudgetUsd` as its "aligned" signal).
 *
 * #1341 fast-follow (liveness fix — SAFETY was never violated, this closes an
 * over-hold): the pre-#1341 version did this as a read-then-decide-then-write
 * `db.transaction` — a SELECT (this function's own row lookup), an `await`
 * into `unmetBlockers` (a SECOND round trip), THEN a final UPDATE. That is
 * three separate statements with real wall-clock time between the blocker
 * read and the write, and `unparkDependents` (below) is NOT wrapped in any
 * transaction at all (each of ITS selects/updates auto-commits independently)
 * — so the two could interleave: `unparkDependents` reads this row's
 * pre-confirm state (`estimated_budget_usd` still NULL) WHILE this function's
 * blocker-read has already decided "still unmet" from an equally-stale
 * snapshot, and by the time BOTH finally write, the row wedges parked with a
 * stale "Waiting on #N" reason, a written budget, and an ALREADY-GREEN
 * dependency — over-held forever (both one-shot release paths consumed; see
 * issue #1341 for the full two-connection repro of both orderings).
 *
 * THE FIX: collapse the read-then-decide-then-write into ONE UPDATE
 * statement. The blocker recheck is now a correlated subquery evaluated BY
 * POSTGRES as part of the SAME statement that performs the write — under
 * READ COMMITTED, that one statement gets one snapshot, and Postgres's own
 * row-level locking + EvalPlanQual re-check means a concurrent racer can
 * never observe (or leave behind) a "decided but not yet written" half-state
 * for THIS statement, because there isn't one: the decision and the write are
 * now the same atomic operation. This intentionally reimplements
 * `unmetBlockers`'s "is a declared blocker green" check as SQL (a `jsonb_
 * array_elements_text(...) WITH ORDINALITY` walk over this row's own
 * `blocked_by`, matched against sibling rows in the same repo+workspace) —
 * the drift risk the pre-#1341 doc-comment warned about is accepted here on
 * purpose (the alternative, a multi-statement transaction, is exactly the
 * shape that wedges); `formatWaitingOnReason`'s ordering (declared-array
 * order, not numeric order) is preserved via `ORDER BY` on the array's own
 * ordinality, and covered by a live-Postgres proof (see this PR's report) —
 * any future change to `formatWaitingOnReason`'s wording must be mirrored
 * here.
 *
 * The final UPDATE keeps the SAME `state = 'parked'` belt-and-suspenders
 * idempotency guard the pre-#1274/#1341 versions used (see the original
 * doc-comment's rationale, preserved): the CALLER (the Telegram webhook's
 * `handleApprovalCallback`) already gates this on `resolveApproval`'s own
 * atomic pending->approved flip, so a double-tap never reaches this function
 * twice; the guard covers the (still theoretical) case where the row left
 * `parked` some other way first. The `state = 'parked'` predicate is repeated
 * on the final UPDATE's OWN `WHERE` (`qe.state = 'parked'`), NOT left solely
 * in the `target` CTE: under READ COMMITTED a CTE qualifier is evaluated once
 * at the statement snapshot and is NOT re-checked when the row lock is finally
 * taken, but a predicate on the UPDATE's target relation IS re-evaluated by
 * Postgres's EvalPlanQual against the freshly-locked row version. Keeping it
 * on the UPDATE is therefore what actually makes the no-op below true "at
 * lock time" rather than merely "at snapshot time" — a concurrent writer that
 * moves the row out of `parked` inside the confirm window causes zero rows to
 * match instead of this statement clobbering it. Do NOT fold this back into
 * the CTE. Returns `false` (no-op, never throws) when no row matches `id` +
 * `state = 'parked'` at lock time —
 * including the #1341 requireAlignment-flip edge (operator flips
 * `require_alignment` off mid-flight -> a dependency clears -> the row
 * releases to `queued` via `unparkDependents`'s own `!requireAlignment`
 * escape -> a stale Approve tap lands here afterward and finds no parked row
 * -> `false`, logged by the caller). This is DELIBERATELY left a no-op rather
 * than widened to also match a `queued`/`running`/terminal row: the ceiling
 * this function exists to sanction cannot retroactively enforce anything once
 * the entry is already running unparked, and loosening the guard would risk
 * writing budget/model onto a row a DIFFERENT mechanism (a denial, a later
 * requeue) has since taken responsibility for — narrower and provably safe
 * beats reaching further for a purely cosmetic backfill. Operator-initiated,
 * logged, and pinned by an explicit test (see this PR's report for the
 * chosen option and rationale).
 *
 * `taskType` (#1338 PR①, required — not optional, so a call site can never
 * silently forget to wire it): the classifier's output off the confirmed
 * brief's own `toolInput.taskType` (top-level on an `alignment_brief`
 * approval — see `AlignmentBriefToolInput` on the console side), denormalized
 * onto the queue entry HERE, at confirm time, alongside the existing
 * estimatedBudgetUsd/modelOverride threading. `null` when the caller has no
 * usable task type (a malformed/pre-#1338 toolInput) — this never blocks the
 * confirm itself, exactly like a missing task type never blocks
 * `enqueueGithubIssue`'s own brief-values extraction.
 */
export async function confirmAlignmentBrief(input: {
  queueEntryId: string;
  estimatedBudgetUsd: number;
  modelOverride: string;
  taskType: string | null;
}): Promise<boolean> {
  const rows = (await db.execute(sql`
    WITH target AS (
      SELECT id, workspace_id, external_id, blocked_by
      FROM queue_entries
      WHERE id = ${input.queueEntryId} AND state = 'parked'
    ),
    blockers AS (
      SELECT
        t.id,
        b.ord,
        b.num,
        EXISTS (
          SELECT 1 FROM queue_entries g
          WHERE g.workspace_id = t.workspace_id
            AND g.external_id = split_part(t.external_id, '#', 1) || '#' || b.num
            AND g.state = 'green'
        ) AS is_green
      FROM target t
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(t.blocked_by, '[]'::jsonb))
        WITH ORDINALITY AS b(num, ord)
    ),
    agg AS (
      SELECT
        t.id,
        COUNT(*) FILTER (WHERE bl.id IS NOT NULL AND NOT bl.is_green) AS unmet_count,
        string_agg('#' || bl.num, ', ' ORDER BY bl.ord)
          FILTER (WHERE bl.id IS NOT NULL AND NOT bl.is_green) AS waiting_on
      FROM target t
      LEFT JOIN blockers bl ON bl.id = t.id
      GROUP BY t.id
    )
    UPDATE queue_entries qe
    SET
      state = CASE WHEN agg.unmet_count = 0 THEN 'queued' ELSE 'parked' END,
      park_reason = CASE
        WHEN agg.unmet_count = 0 THEN NULL
        ELSE 'Waiting on ' || agg.waiting_on
      END,
      estimated_budget_usd = ${input.estimatedBudgetUsd},
      model_override = ${input.modelOverride},
      task_type = ${input.taskType},
      updated_at = now()
    FROM agg
    WHERE qe.id = agg.id AND qe.state = 'parked'
    RETURNING qe.id
  `)) as unknown as Array<{ id: string }>;
  return Array.from(rows).length > 0;
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

// --- revise loop (#1345 PR②) --------------------------------------------------
//
// Today, a denied alignment brief parks its queue entry with
// ALIGNMENT_DENIED_PARK_REASON PERMANENTLY: neither unparkDependents nor
// requeueParkedQueueEntry below will ever touch a row carrying it, and there
// is no mechanized way to reshape the ask and try again (only a human
// hand-editing the GitHub issue). The two functions below are the state-
// transition half of the fix: `findQueueEntryByExternalId` is how the
// console's revise route (apps/console/app/api/v1/runner/queue-entries/
// revise/route.ts) finds WHICH queue entry a `update_issue` tool call's
// edited issue maps to, and `reviseAlignmentBrief` is what actually
// supersedes the denial — clearing it back to "awaiting alignment" so a
// FRESH brief can be composed+posted (via `alignment-reconciler.ts`'s
// `postAlignmentBrief`, reusing the exact same composer, with a request id
// distinct from the denied approval's own so a NEW `jace_approvals` row is
// created rather than colliding with the resolved one — see that function's
// own `requestId` param).
//
// AC3 (the gate invariant, CRITICAL): `reviseAlignmentBrief` NEVER touches
// `state` (the row stays 'parked' the entire time, before/during/after this
// call) and NEVER writes `estimatedBudgetUsd`/`modelOverride`/`taskType` to
// anything but `null`. The ONLY function that can ever flip `state` to
// `queued` is {@link confirmAlignmentBrief} above — completely untouched by
// this PR — which requires a fresh `approved` `alignment_brief` approval to
// have been resolved first (via `applyAlignmentDecision`,
// `apps/console/lib/approval-decision.ts`). A revised-but-not-yet-confirmed
// row is therefore indistinguishable, to every other reader in this file
// (`unparkDependents`'s `aligned` check, `requeueParkedQueueEntry`'s
// `aligned` check, a runner `claim` — which only ever grabs `state =
// 'queued'` rows), from any other not-yet-confirmed alignment hold: it
// cannot be released by a resolved dependency, cannot be Requeue-button'd
// past the gate, and cannot be claimed. A denied entry can go through this
// revise→re-brief cycle any number of times (deny → revise → deny → revise
// → ...) — each cycle is symmetric with the very first admission-time
// brief, just re-entered from a different starting park reason.

/**
 * Read-only lookup: find a GitHub-sourced queue entry by its (workspace,
 * repo, issue number) address — the deterministic `owner/repo#N` external id
 * {@link enqueueGithubIssue} writes. Exported (rather than exporting
 * `entryId`'s internal uuid5-hashing helper itself) so the console's revise
 * route can find WHICH parked entry an `update_issue` tool call's edited
 * issue corresponds to without needing to know how that id is derived.
 */
export interface QueueEntryLookup {
  id: string;
  state: string;
  parkReason: string | null;
  title: string;
  body: string;
}

export async function findQueueEntryByExternalId(
  workspaceId: string,
  repoFullName: string,
  number: number
): Promise<QueueEntryLookup | null> {
  const externalId = `${repoFullName}#${number}`;
  const rows = await db
    .select({
      id: queueEntries.id,
      state: queueEntries.state,
      parkReason: queueEntries.parkReason,
      title: queueEntries.title,
      body: queueEntries.body,
    })
    .from(queueEntries)
    .where(
      and(
        eq(queueEntries.workspaceId, workspaceId),
        eq(queueEntries.source, "github"),
        eq(queueEntries.externalId, externalId)
      )
    );
  return rows[0] ?? null;
}

/**
 * Outcome of {@link reviseAlignmentBrief} — discriminated (not a bare
 * boolean) so the caller (the console revise route) can log/respond with an
 * honest, specific reason. `updatedAt` on success is what the caller folds
 * into the fresh brief's request id (see that route's own comment) so two
 * separate revise rounds for the SAME queue entry never collide on the same
 * `jace_approvals` request id.
 */
export type ReviseAlignmentBriefResult =
  | { ok: true; updatedAt: Date }
  | { ok: false; reason: "not_found" | "not_denied" };

/**
 * Supersede a DENIED alignment hold with the user's revised title/body,
 * clearing the denial back to {@link ALIGNMENT_PARK_REASON} ("awaiting
 * alignment") so a fresh brief can be posted — the state-transition half of
 * the #1345 revise loop.
 *
 * Guarded exactly like {@link denyAlignmentBrief}/{@link confirmAlignmentBrief}:
 * a read-then-write in one transaction so the caller gets an HONEST reason
 * (`not_found` vs `not_denied`) rather than a bare boolean, while the actual
 * enforcement is the final UPDATE's own `WHERE` — re-asserting `state =
 * 'parked' AND park_reason = ALIGNMENT_DENIED_PARK_REASON` at write time,
 * never trusted from the initial read alone (mirrors
 * `requeueParkedQueueEntry`'s own rationale for the same shape). Returns
 * `not_denied` for ANY entry not currently in the denied state — including
 * one that raced to a different state between the read and the write, or a
 * SECOND call for a revise that already succeeded (the first call already
 * cleared the denial, so `park_reason` no longer matches and this is a safe
 * no-op). That idempotency is also what makes the CALLER's own re-brief-post
 * safe to gate on this function's result: it only ever composes+posts a
 * fresh brief when this returns `ok: true`, so a retried HTTP call can never
 * post two briefs for one genuine revise.
 *
 * NEVER writes `state` (stays `parked` throughout — see this section's own
 * "AC3" note above) and explicitly resets `estimatedBudgetUsd`/
 * `modelOverride`/`taskType` to `null` — not just "leaves them alone": a
 * denied entry never had them set in the first place (only
 * `confirmAlignmentBrief` ever writes those three columns, and it never ran
 * for a denied entry), but spelling it out here is defense-in-depth against
 * this function ever being reused for a row that somehow did carry stale
 * values.
 */
export async function reviseAlignmentBrief(input: {
  queueEntryId: string;
  title: string;
  body: string;
}): Promise<ReviseAlignmentBriefResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ state: queueEntries.state, parkReason: queueEntries.parkReason })
      .from(queueEntries)
      .where(eq(queueEntries.id, input.queueEntryId));
    const row = rows[0];
    if (!row) return { ok: false, reason: "not_found" as const };
    if (row.state !== "parked" || row.parkReason !== ALIGNMENT_DENIED_PARK_REASON) {
      return { ok: false, reason: "not_denied" as const };
    }

    const updated = await tx
      .update(queueEntries)
      .set({
        title: input.title,
        body: input.body,
        parkReason: ALIGNMENT_PARK_REASON,
        estimatedBudgetUsd: null,
        modelOverride: null,
        taskType: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(queueEntries.id, input.queueEntryId),
          eq(queueEntries.state, "parked"),
          eq(queueEntries.parkReason, ALIGNMENT_DENIED_PARK_REASON)
        )
      )
      .returning({ updatedAt: queueEntries.updatedAt });

    if (updated.length === 0) return { ok: false, reason: "not_denied" as const };
    return { ok: true, updatedAt: updated[0]!.updatedAt };
  });
}

/**
 * Outcome of a {@link requeueParkedQueueEntry} call — discriminated so the
 * console (#1276 PR ②) can show an honest, specific reason rather than a
 * bare boolean. `alignment_locked` is the load-bearing case: an
 * alignment-held row resolves EXCLUSIVELY through the posted brief's own
 * Approve/Deny — a raw requeue bypassing it would let unpriced work back
 * onto the queue, reintroducing the exact bug #1274 closed.
 */
export type RequeueParkedQueueEntryResult =
  | "requeued"
  | "not_found"
  | "not_parked"
  | "alignment_locked";

/**
 * Requeue a single parked `queue_entries` row — the console approvals page's
 * Requeue action (#1276 PR ②) for a guardrail (duplicate content / rate
 * limit / injection screen) or dependency ("Waiting on #N") park.
 *
 * ALIGNMENT GATE (adversarial-review fix, #1276 fix round): "is this row
 * alignment-held?" is NOT a `parkReason` string match — a dependency- or
 * guardrail-parked issue under `require_alignment` carries the dependency/
 * guardrail reason while its brief is still pending (`estimatedBudgetUsd`
 * NULL), and the original string-only check flipped exactly such a row
 * straight to claimable/unpriced, silently orphaning the brief (its later
 * approve matches no parked row). This mirrors {@link unparkDependents}'
 * aligned check EXACTLY, on the same rationale documented there
 * (`estimatedBudgetUsd IS NOT NULL` is the only trustworthy "confirmed"
 * marker):
 *   - a DENIED row ({@link ALIGNMENT_DENIED_PARK_REASON}) is refused
 *     unconditionally — a denial is a stronger hold than anything a requeue
 *     could say, exactly as `unparkDependents` refuses to touch one.
 *   - otherwise aligned = `kind !== 'issue'` OR `estimatedBudgetUsd IS NOT
 *     NULL` OR NOT `workspace.require_alignment`. Aligned -> requeue
 *     (`queued`, reason cleared). NOT aligned -> the row STAYS parked and
 *     its `parkReason` flips to {@link ALIGNMENT_PARK_REASON} — turning the
 *     now-stale dependency/guardrail reason honest (the brief is what it's
 *     actually waiting on; #1274 PR ③'s reconciler is what posts a missing
 *     brief) — and the caller gets `alignment_locked` to render.
 *
 * Read-then-write in ONE `db.transaction` (this function's OWN read-then-
 * write stays a transaction, unlike the post-#1341 {@link confirmAlignmentBrief}
 * — see that function's doc-comment for why it moved off this shape): the
 * read distinguishes WHY a requeue didn't happen so the caller can render a
 * specific, honest reason — while the actual enforcement is the final
 * UPDATE's own `WHERE` clause, which re-asserts the full aligned predicate
 * (never trust a pre-check alone for a security property, the same posture
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
      .select({
        state: queueEntries.state,
        parkReason: queueEntries.parkReason,
        kind: queueEntries.kind,
        estimatedBudgetUsd: queueEntries.estimatedBudgetUsd,
      })
      .from(queueEntries)
      .where(and(eq(queueEntries.id, id), eq(queueEntries.workspaceId, workspaceId)));
    const row = rows[0];
    if (!row) return "not_found";
    if (row.state !== "parked") return "not_parked";

    // A denial always wins — refused regardless of the gate flag, mirroring
    // unparkDependents' own denied-rows-are-untouchable rule.
    if (row.parkReason === ALIGNMENT_DENIED_PARK_REASON) return "alignment_locked";

    const requireAlignment = await workspaceRequiresAlignment(tx, workspaceId);
    const aligned =
      row.kind !== "issue" ||
      row.estimatedBudgetUsd !== null ||
      !requireAlignment;

    if (!aligned) {
      // Stays parked; the stored reason flips to the TRUE hold (the brief),
      // replacing a now-misleading dependency/guardrail reason. Guarded the
      // same way every parked-row write in this file is.
      await tx
        .update(queueEntries)
        .set({ parkReason: ALIGNMENT_PARK_REASON, updatedAt: new Date() })
        .where(
          and(
            eq(queueEntries.id, id),
            eq(queueEntries.workspaceId, workspaceId),
            eq(queueEntries.state, "parked")
          )
        );
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
          // Belt-and-suspenders: the WHERE re-asserts the FULL aligned
          // predicate (denial + the unparkDependents-mirrored check), so a
          // row that changed between the read above and this write can never
          // slip through on stale read data. `requireAlignment` was read in
          // this same transaction.
          sql`${queueEntries.parkReason} IS DISTINCT FROM ${ALIGNMENT_DENIED_PARK_REASON}`,
          sql`(${queueEntries.kind} <> 'issue' OR ${queueEntries.estimatedBudgetUsd} IS NOT NULL OR ${!requireAlignment})`
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
  // #1274 PR ②: written from a MATCHED confirmed-brief approval's own
  // `_brief` (chat-born one-confirm collapse) — see the block below. `null`
  // (the column's own default) unless that match succeeds; explicit here
  // rather than omitted so this is always the SAME insert shape regardless
  // of which branch below ran.
  let estimatedBudgetUsd: number | null = null;
  let modelOverride: string | null = null;
  // #1338 PR①: denormalized alongside estimatedBudgetUsd/modelOverride, from
  // the SAME matched brief's `_brief.taskType` — same lifecycle, same
  // "written regardless of queued vs dependency-parked" rule below.
  let taskType: string | null = null;
  if (!v2Parked) {
    const requireAlignment = await workspaceRequiresAlignment(db, data.workspaceId);
    if (requireAlignment) {
      const issueUrl = githubIssueUrl(data.repoFullName, data.number);
      const matched = await findConfirmedAlignmentBriefApproval(data.workspaceId, issueUrl);

      if (matched) {
        const briefValues = extractBriefBudgetAndModel(matched.toolInput);
        if (briefValues) {
          // #1274 PR ②, BOLDED PIN 1: the sanctioned values are written
          // onto the entry HERE, AT ADMISSION, REGARDLESS of whether the
          // entry lands `queued` or dependency-`parked` below — `state`/
          // `parkReason` are left completely untouched by this branch (a
          // dependency park keeps its own "Waiting on #N" reason exactly
          // as the pre-#1274 behaviour did; a clean admit stays `queued`).
          // This is load-bearing, not cosmetic: `unparkDependents` (this
          // file) gates release on `estimatedBudgetUsd IS NOT NULL` as its
          // sole "aligned" signal. A chat-born entry that admits into a
          // "Waiting on #N" park WITHOUT its values written here would
          // read as never-aligned once the blocker clears, and
          // unparkDependents would WRONGLY flip its park reason back to
          // "awaiting alignment" — even though the brief genuinely WAS
          // confirmed via the one-confirm collapse before this row was
          // ever inserted. No brief posting is needed either way — it was
          // already confirmed — so `parkedFor` is left unset in this
          // branch (unlike the unmatched branch below).
          estimatedBudgetUsd = briefValues.estimatedBudgetUsd;
          modelOverride = briefValues.modelOverride;
          taskType = briefValues.taskType;
        } else if (state !== "queued") {
          // #1274 PR ②, BOLDED PIN 2 ("the no-`_brief` fallback
          // restriction"): `matched` but no usable `_brief` — a
          // pre-#1274-PR② approval row (recorded before this enrichment
          // existed; a narrow deploy-ordering window, see
          // `extractBriefBudgetAndModel`'s doc-comment) that nonetheless
          // got approved and later stamped. PR ①'s original "admit clean,
          // no values" fallback (the `else` branch just below) is safe
          // ONLY for a row landing cleanly `queued`. It is NOT safe here,
          // where the entry would otherwise land dependency-`parked`: a
          // values-less "confirmed" park would wedge at unpark forever
          // (unparkDependents reads `estimatedBudgetUsd === null` as
          // never-aligned and would re-park it "awaiting alignment" once
          // the blocker clears, with no brief left to confirm against — a
          // dead end). So for THIS landing, treat the lookup as NOT
          // confirmed and fall through to the normal brief-needed path
          // instead: `parkedFor` fires so the console route composes+posts
          // a FRESH brief, exactly like the unmatched branch below. A
          // redundant second confirm is the correct fail-safe direction —
          // the same one this whole gate always fails toward.
          parkedFor = "awaiting_alignment";
        }
        // else (no `_brief`, but `state === "queued"`): PR①'s original
        // no-values fallback — admit clean, `parkedFor` stays unset,
        // byte-identical to the pre-#1274-PR② behaviour.
      } else {
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
      estimatedBudgetUsd,
      modelOverride,
      taskType,
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

// --- reconciler seam (#1274 PR③) ----------------------------------------------
//
// The find-side of `apps/console/lib/alignment-reconciler.ts::reconcileAlignmentBriefs`.
// Every other write in this file lives here (db-postgres owns all raw drizzle
// access; the console layer only ever calls exported functions like this one
// — see `findWorkspaceByRepo` above for the same raw-SQL idiom this mirrors),
// so this read lives here too even though its caller is console-side.

export interface AlignmentBriefCandidate {
  id: string;
  workspaceId: string;
  source: string;
  externalId: string;
  title: string;
  body: string;
}

/**
 * Find `queue_entries` rows genuinely stuck with no recovery path for an
 * alignment brief (#1274 PR③): PARKED, issue-kind, IN THE GIVEN WORKSPACE
 * (which must require alignment), carrying no sanctioned budget yet, AND —
 * the discriminant that matters — no `jace_approvals` row references them
 * at all. This single criterion covers every case named in the task brief:
 *
 *  - Python-admitted rows (`agentrail/afk/queue_store.py`'s new admission
 *    hold): Python posts no brief itself, so every such row has zero
 *    approval rows by construction.
 *  - `postAlignmentBrief`'s `no_session`/`compose_failed`/
 *    `session_lookup_failed`/`record_failed` outcomes: all four leave
 *    genuinely zero approval rows (the failure happens BEFORE
 *    `recordApprovalRequest` succeeds, or that call itself is what failed).
 *  - A v2-guardrail-parked entry whose reason `unparkDependents` later
 *    overwrote to `ALIGNMENT_PARK_REASON` once an UNRELATED dependency
 *    cleared (the case the #1274 PR② reviewer flagged) — it never went
 *    through the alignment admission gate at all, so it too has zero
 *    approval rows.
 *
 * EXCLUDED by the `park_reason NOT LIKE '%parked for human review%'` guard:
 * a v2-guardrail park that STILL carries its OWN, not-yet-overwritten
 * guardrail reason (injection / duplicate-content / rate-limit — every one
 * of those reason strings, in BOTH `github_intake.ts`'s `screenV2` and
 * Python's `input_contract.py`, contains this exact phrase; neither the
 * alignment reason nor any dependency ("Waiting on #N" /
 * "blocked-by unmet dependency: #N") reason ever does). That park needs a
 * human's Requeue/Deny on the guardrail itself, not an alignment brief.
 * `park_reason IS NULL` is treated as "needs a brief" (the safe direction —
 * a parked row should never legitimately have a null reason, but if one
 * somehow does, silently never reconciling it is worse than one maybe-
 * redundant brief).
 *
 * DELIBERATELY OUT OF SCOPE (a real, narrower residual gap, documented
 * rather than guessed at — see this PR's report): `postAlignmentBrief`'s
 * `send_failed` outcome runs AFTER `recordApprovalRequest` already
 * succeeded (the approval row exists, status='pending', just never
 * delivered) — such a row has an approval row and so is NOT found here.
 * Recovering it would need a "was this ever actually delivered" signal this
 * schema doesn't carry today.
 *
 * A DENIED entry always has an approval row (the one that was denied) — the
 * "no approval row" criterion alone already keeps it out of scope, matching
 * the task brief's explicit exclusion.
 *
 * WORKSPACE-SCOPED (#1274 PR③ fix round, review finding I2): the original
 * version had no `workspace_id` predicate — a GLOBAL oldest-first
 * `LIMIT n` across all tenants. Two failure modes: (a) starvation — a
 * `no_session` failure leaves no approval row BY DESIGN (so the sweep can
 * retry it later), which means one Telegram-less tenant's n oldest,
 * permanently-unrecoverable candidates re-match every sweep forever and
 * starve every other workspace's recovery; (b) cross-tenant coupling —
 * workspace A's queue activity drives brief sends for idle workspace B.
 * Both call sites (the github-webhook and runner-result routes) already
 * hold the workspaceId of the activity that triggered the sweep, so the
 * scope costs nothing. `limit` now bounds candidates WITHIN the workspace.
 *
 * Oldest-first, bounded by `limit` — the caller's bound, not a constant
 * here, so the choice stays visible at the call site.
 */
export async function findAlignmentBriefCandidates(
  workspaceId: string,
  limit: number
): Promise<AlignmentBriefCandidate[]> {
  const rows = (await db.execute(sql`
    SELECT qe.id, qe.workspace_id, qe.source, qe.external_id, qe.title, qe.body
    FROM queue_entries qe
    JOIN workspaces w ON w.id = qe.workspace_id
    WHERE qe.workspace_id = ${workspaceId}
      AND qe.state = 'parked'
      AND qe.kind = 'issue'
      AND w.require_alignment = true
      AND qe.estimated_budget_usd IS NULL
      AND (qe.park_reason IS NULL OR qe.park_reason NOT LIKE '%parked for human review%')
      AND NOT EXISTS (
        SELECT 1 FROM jace_approvals ja WHERE ja.queue_entry_id = qe.id
      )
    ORDER BY qe.created_at ASC
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    workspace_id: string;
    source: string;
    external_id: string;
    title: string;
    body: string;
  }>;
  return Array.from(rows).map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    source: r.source,
    externalId: r.external_id,
    title: r.title,
    body: r.body,
  }));
}

// --- revise-recovery seam (#1345 PR③ / AC2 follow-up: crash-window liveness gap) ---
//
// `reviseAlignmentBrief` commits DENIED -> `ALIGNMENT_PARK_REASON` (clearing
// the denial) as its OWN transaction, and the caller (the console revise
// route, or the webhook's `edited` branch) then calls `postAlignmentBrief` as
// a SEPARATE step right after. If the process dies in between — after the
// revise commits, before the fresh brief posts — the entry is left sitting
// "awaiting alignment" with NO pending brief and NO recovery path:
// `findAlignmentBriefCandidates` above requires `NOT EXISTS (any
// jace_approvals row)`, but this entry still carries its OLD *denied*
// approval row (kept forever, by design, as an audit trail — see
// `reviseAlignmentBrief`'s own doc-comment) — so it can never match that
// query. `postAlignmentBrief`'s own doc-comment promises "the next
// reconciler sweep retries"; this closes the gap in that promise the revise
// path opened.
//
// Deliberately a SEPARATE query rather than a loosened
// `findAlignmentBriefCandidates`: that function's `NOT EXISTS (any approval
// row)` criterion is exactly what keeps a genuinely-still-denied entry (whose
// only approval row is the denial itself) OUT of the admission-recovery
// sweep — loosening it to admit this case would also admit every denied row
// that was never revised, silently spamming a fresh brief for entries a human
// deliberately denied and has not touched since. This query's criterion is
// therefore the narrow, positive proof of "this row WAS denied, then WAS
// revised, and has no live brief yet" — never a superset of the existing one.

export interface RevisedBriefRecoveryCandidate {
  id: string;
  workspaceId: string;
  source: string;
  externalId: string;
  title: string;
  body: string;
  // The revise transition's own `updated_at` — the caller derives the
  // recovery post's request id from this EXACT value
  // (`alignment-brief:${id}:revise-${updatedAt.getTime()}`), which is what
  // makes it converge with a same-entry direct post: both sides read this
  // same column, set once by `reviseAlignmentBrief`'s UPDATE and untouched by
  // anything else while the row waits for its fresh brief.
  updatedAt: Date;
}

/**
 * Find `queue_entries` rows stuck in the #1345 revise-loop's crash window:
 * PARKED, issue-kind, IN THE GIVEN WORKSPACE (which must require alignment),
 * carrying no sanctioned budget, currently parked for
 * {@link ALIGNMENT_PARK_REASON} (i.e. NOT still denied — a prior
 * {@link reviseAlignmentBrief} call already cleared the denial), WITH a
 * `jace_approvals` row proving that clearing really happened (a `denied` row
 * for this entry — the audit trail {@link reviseAlignmentBrief} leaves
 * behind), and WITHOUT any `pending` `jace_approvals` row (no live brief
 * exists to answer yet).
 *
 * This is additive and disjoint from {@link findAlignmentBriefCandidates}:
 * that query's `NOT EXISTS (any approval row at all)` criterion already
 * excludes every row this one matches (a revised-then-recovered row always
 * has at least the old denied row), so the two candidate sets never overlap
 * and this function can never re-admit something the admission-recovery
 * sweep already owns.
 *
 * Oldest-first BY THE REVISE TRANSITION'S OWN `updated_at` (not
 * `created_at` — the entry may have been admitted long ago; what matters
 * here is how long it's been stuck since the revise cleared the denial),
 * bounded by `limit` — mirrors {@link findAlignmentBriefCandidates}'s own
 * "caller's bound, not a constant here" rule.
 */
export async function findRevisedBriefRecoveryCandidates(
  workspaceId: string,
  limit: number
): Promise<RevisedBriefRecoveryCandidate[]> {
  const rows = (await db.execute(sql`
    SELECT qe.id, qe.workspace_id, qe.source, qe.external_id, qe.title, qe.body, qe.updated_at
    FROM queue_entries qe
    JOIN workspaces w ON w.id = qe.workspace_id
    WHERE qe.workspace_id = ${workspaceId}
      AND qe.state = 'parked'
      AND qe.kind = 'issue'
      AND w.require_alignment = true
      AND qe.estimated_budget_usd IS NULL
      AND qe.park_reason = ${ALIGNMENT_PARK_REASON}
      AND EXISTS (
        SELECT 1 FROM jace_approvals ja
        WHERE ja.queue_entry_id = qe.id AND ja.status = 'denied'
      )
      AND NOT EXISTS (
        SELECT 1 FROM jace_approvals ja
        WHERE ja.queue_entry_id = qe.id AND ja.status = 'pending'
      )
    ORDER BY qe.updated_at ASC
    LIMIT ${limit}
  `)) as unknown as Array<{
    id: string;
    workspace_id: string;
    source: string;
    external_id: string;
    title: string;
    body: string;
    updated_at: Date;
  }>;
  return Array.from(rows).map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    source: r.source,
    externalId: r.external_id,
    title: r.title,
    body: r.body,
    updatedAt: new Date(r.updated_at),
  }));
}
