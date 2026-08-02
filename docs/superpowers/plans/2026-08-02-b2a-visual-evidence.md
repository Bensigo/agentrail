# B2a Visual Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every behavioral AC the QA stage verifies (or fails) carries per-AC screenshots, stored in the house object store and linked from the posted review — working on rung-1 (preview-URL) PRs with no sandbox.

**Architecture:** Console owns storage (new greenfield S3 client module + upload/re-sign runner routes + a `review_jobs.evidence_keys` column). Jace owns capture (QA schema gains `evidence_images`, a new `upload_evidence_image` QA tool, instructions protocol) and presentation (`post_pr_review` renders evidence links). Additive everywhere: absent evidence behaves byte-identically to today.

**Tech Stack:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (NEW console deps), Next.js routes + vitest, jace `.core.mjs` convention + node:test, one Drizzle hand-authored migration.

**Spec:** `docs/superpowers/specs/2026-08-02-b2-behavioral-evidence-design.md` (§1-§3, merged #1571).

## Global Constraints

- Worktree branch `feat/b2a-visual-evidence`. Repo hook blocks Grep/Glob and bare `grep` — Read exact paths; python heredocs for searches.
- `apps/jace`: `pnpm install --ignore-workspace`; NEVER commit `apps/jace/pnpm-lock.yaml`. Console tests via its package script; db-postgres integration tests need `DATABASE_URL=postgres://agentrail:agentrail@localhost:5434/agentrail`.
- Migration journal gotcha: hand-authored SQL; recompute next filename AND journal idx live (they differ; last known 0066/idx 70 — verify).
- Key scheme EXACT: `review-evidence/<workspaceId>/<repo>/<prNumber>/<headSha>/<acId>/<n>.png` (repo slashes are path segments — sanitize repo to `owner__name` in the key to avoid ambiguity; document).
- Caps EXACT: 2MB decoded per image, 4 images per AC. Signed GET TTL: 30 days.
- Session resolution: the runner-route chain incl. identity-less sessions (post-#1569 semantics — `Session not found` 404 wording).
- The unrelated `apps/console/lib/evidence/` observability system is untouched; every new file carries a one-line "not lib/evidence — see spec §1 naming note" comment where confusion is plausible.
- QA schema changes are ADDITIVE (validateAdvisory: absent `evidence_images` = today's behavior, byte-identical).
- `post_pr_review`'s count-line/judgment fold rules untouched — links append to per-AC lines only.
- Env: `S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET` finally get their reader; `REVIEW_EVIDENCE_ENABLED` (console, default off) gates the upload route (503 "evidence storage not enabled" when off). `.env.example` comments updated to say the vars are now read.
- Commit after each task.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/console/lib/artifacts/store.ts` (+ test) | S3 client, putArtifact, signedGetUrl, key builder |
| `apps/console/app/api/v1/runner/review-evidence/route.ts` (+ test) | POST upload, GET re-sign |
| db migration + `review_jobs.ts` schema + `review_jobs.ts` queries | `evidence_keys jsonb` + complete passthrough |
| `apps/jace/agent/subagents/qa/lib/qa.core.mjs` (+ tests) | `evidence_images` in schema + validator |
| `apps/jace/agent/subagents/qa/tools/upload_evidence_image.ts` + `lib/upload_evidence_image.core.mjs` (+ tests) | the QA upload tool |
| `apps/jace/agent/subagents/qa/instructions.md` (+ prose pins) | capture-per-AC protocol |
| `apps/jace/agent/lib/post_pr_review.core.mjs` (+ tests) | evidence links rendering |
| root `instructions.md` + `review_job_prompt.mjs` (+ pins) | one-sentence relay rules |

---

### Task 1: The artifact store (console, greenfield)

**Files:** Create `apps/console/lib/artifacts/store.ts`, `apps/console/lib/artifacts/store.test.ts`; modify `apps/console/package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).

**Interfaces (produces):**
- `artifactKey({workspaceId, repo, prNumber, headSha, acId, index, ext}) -> string` — the exact scheme with repo sanitized (`/`→`__`); pure, unit-tested (traversal-hostile inputs: `..`, empty segments rejected by throwing).
- `putArtifact(key, bytes: Buffer, contentType) -> Promise<void>` — S3 PutObject against env config; throws when any S3_* var is missing (the route turns that into its 503-when-disabled/500 paths).
- `signedGetUrl(key, ttlSeconds = 2_592_000) -> Promise<string>` — presigned GET.
- `storageConfigured(env) -> boolean` — all four vars present.

- [ ] Steps: TDD (key-builder pure tests first incl. hostile inputs; client functions tested against minio when `DATABASE_URL`-style reachability allows — the dev compose serves minio on :9000 with bucket `agentrail-artifacts`; if unreachable, test through the SDK boundary with an injected client factory and say so honestly) → implement → console suite green → Commit: `feat(console): artifact store — the S3 seam finally gets its reader (B2a §1)`

### Task 2: The review-evidence routes

**Files:** Create `apps/console/app/api/v1/runner/review-evidence/route.ts` + colocated test.

**Behavior (each line a mandatory test):** auth via `requireJaceConsoleSecret`; `REVIEW_EVIDENCE_ENABLED !== "1"` → 503 `{error:"evidence storage not enabled"}`; POST body `{eveSessionId, repo, prNumber, headSha, acId, imageBase64, contentType}` all required (400); session chain resolves workspace (identity-less row test mandatory) and `getRepositoryByName` gates repo (404); contentType allowlist `image/png|image/jpeg` (415); decoded size > 2MB → 413; per-AC count: HEAD the store? — v1 track via key index param `n` supplied by caller with cap 4 (422 beyond; document the honesty: caller-counted v1); success → `putArtifact` + 200 `{key, url}`; GET `?key=` → validates the key's prefix + workspace ownership (the key embeds workspaceId — must match the session's) → 200 `{url}` re-signed.

- [ ] Steps: TDD → implement → console suite green → Commit: `feat(console): review-evidence upload + re-sign routes (B2a §1)`

### Task 3: `review_jobs.evidence_keys` + complete passthrough

**Files:** migration (recompute slot/idx) + `packages/db-postgres/src/schema/review_jobs.ts` (+`evidence_keys jsonb`, nullable) + `queries/review_jobs.ts` (`completeReviewJob` accepts optional `evidenceKeys: string[]`, written on posted) + console `complete/route.ts` passthrough + jace `review_job_console.mjs`/core complete fields passthrough + `REVIEW_JOB_RESULT_SCHEMA` gains optional `evidenceKeys: string[]` + tests at each layer (schema↔SQL agreement; guarded update; route passthrough; worker field mapping).

- [ ] Steps: TDD per layer → suites (db-postgres with DATABASE_URL, console, jace) green → Commit: `feat(review-jobs): evidence_keys ride complete — Arc D's attachment point (B2a §1)`

### Task 4: QA schema + upload tool

**Files:** `qa.core.mjs` (+`evidence_images` optional `string[]` per ac_result, cap 4, validateAdvisory additive rules + tests), new `apps/jace/agent/subagents/qa/tools/upload_evidence_image.ts` + `apps/jace/agent/subagents/qa/lib/upload_evidence_image.core.mjs` (+ core test): input `{acId, prCoordinates?, imageBase64, contentType}` — the PR coordinates come from the task prompt; the tool takes them as explicit args (root's dispatch includes them; QA relays) — calls the console route with the sibling tools' session-resolution + `resolveConsoleConfig` conventions; returns `{url}`; errors degrade to a structured `{error}` the QA model reports in prose (never throws the turn dead).

- [ ] Steps: TDD → `cd apps/jace && pnpm test` green → Commit: `feat(jace): QA evidence_images + upload_evidence_image tool (B2a §2)`

### Task 5: QA capture protocol

**Files:** `qa/instructions.md` + prose-pin tests (the existing qa-ac-instructions test file's style).

Verbatim-required additions (adapt glue only): after each behavioral AC's decisive observation, capture a screenshot with the browser connection's screenshot tool and upload it via `upload_evidence_image`, putting the returned URL in that AC's `evidence_images`; a `failed` AC captures the FAILING state; `not_testable` captures nothing — the reason stands alone; never fabricate or reuse another AC's image; if upload errors, say so in `notes` and continue (evidence is additive, never a reason to abort verification).

- [ ] Steps: pins first → implement → jace suite green → Commit: `feat(jace): QA captures per-AC visual evidence — prose-pinned (B2a §2)`

### Task 6: Review rendering + relay sentences

**Files:** `post_pr_review.core.mjs` (+ tests): per-AC rendered lines append ` — [evidence 1](url) [evidence 2](url)` when the folded QA entry carries `evidence_images` (cap 4; count line + judgment fold byte-untouched — regression-pinned); root `instructions.md` + `review_job_prompt.mjs`: one sentence each — QA's `evidence_images` ride the fold verbatim into the posted review; pins updated (the prompt's pinned block changes — update its verbatim test accordingly, disclosed).

- [ ] Steps: TDD → jace suite green → Commit: `feat(jace): posted reviews link per-AC evidence (B2a §3)`

### Task 7: Sweeps + AC walk + PR

- [ ] Full suites all four surfaces (db-postgres w/ DATABASE_URL, console, jace, python focused untouched-check) → walk the checklist below → push + PR (coordinator runs final review + merge + live smoke round: one rung-1 PR with `REVIEW_EVIDENCE_ENABLED=1` locally, minio up, real screenshot round-trip).

## Acceptance criteria (final walk)

1. Key scheme exact + hostile-input-safe; store module is the S3 vars' first reader; presigned GET works against minio.
2. Upload route: flag-gated 503, full auth/session chain incl. identity-less, caps enforced (2MB/4-per-AC/content types), returns key+url; GET re-signs with workspace-ownership check.
3. `evidence_keys` lands on posted jobs end-to-end (schema↔SQL agree; worker→route→query passthrough).
4. QA: `evidence_images` additive (absent = byte-identical validator behavior); the upload tool follows sibling conventions and degrades structurally.
5. Instructions: capture-per-AC incl. failing-state + not_testable-captures-nothing + upload-failure-continues, all prose-pinned.
6. Rendering: links append per-AC; count line + judgment fold provably untouched; no-evidence reviews byte-identical.
7. All flags default off; zero behavior change until `REVIEW_EVIDENCE_ENABLED=1`.
8. The `lib/evidence` naming collision is annotated at every plausible confusion point.
