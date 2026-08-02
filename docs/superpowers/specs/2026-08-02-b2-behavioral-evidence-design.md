# B2 — Behavioral Verification: Visual Evidence + Sandbox Boot (Arc B, phase 2)

**Date:** 2026-08-02 · refined build-ready against a full exploration of the live code (post-B1, post-#1570)
**Status:** Build-ready for **B2a**; B2b build-ready in shape with one flagged infra verification step. Supersedes the "Phase B2" paragraphs of `2026-07-31-reviewer-of-record-design.md` (whose directional text this exploration contradicted in ten places — resolved below).
**Scope:** B2a — per-AC visual evidence (screenshots now, recordings later) captured during behavioral verification, stored in the house object store, linked from the posted review. B2b — booting a PR head that has no preview URL so the behavioral stage has something to browse.
**Prior art:** B1 (review jobs, headless worker — live-verified 2026-08-02, review 4838100151 on #1557); the QA subagent's observed-evidence contract; owner ruling #1564 (visual evidence attaches to the PR).
**Non-goals:** hard multi-tenant isolation for boots in v1 (see the honesty ruling in §B2b — hygiene, not a security boundary, exactly like the fleet's documented posture); recordings in B2a (screenshots first; the seam is shaped for both); automatic preview-URL discovery (rung 1 stays LLM-judgment; a deployments-API reader is a later nicety); merge gating.

## Judgment removed

- **Verification** — "the UI works" stops being prose; every behavioral AC verdict carries the pixels that prove it (or the failing state, or the concrete reason nothing could run).
- **Merge confidence** — a human reading the posted review clicks from "AC3: verified" straight to the screenshot; for sandbox-booted PRs, "we ran your branch" becomes checkable fact.

## Problem (what the code actually does today — exploration 2026-08-02)

1. **Capture is half-wired:** `agent_browser_screenshot` / `browser_screenshot` are ALREADY in QA's MCP allowlists (`apps/jace/agent/subagents/qa/lib/connections.core.mjs:69,85`) — but `qa/instructions.md` never asks for a screenshot, `QA_SCHEMA.evidence_refs` is prose `string[]` (`qa.core.mjs:167-173`), and no code anywhere persists a browser artifact.
2. **Storage is dead config:** the console reads NO S3 var — `deploy/.env.production.example:113-116` says so verbatim; zero `S3Client`/presign/upload code exists in `apps/console` or `packages/*`. `apps/console/lib/evidence/` is an unrelated, same-named observability-adapter system persisting text to Postgres. `review_jobs` has no artifact column.
3. **The "fleet isolation tier" the directional text leaned on is not what it claimed:** the Railway fleet is one shared container, no per-task isolation by default (`deploy/fleet/README.md:140-162`); Docker-socket availability on Railway is explicitly unverified (`:194-196`); `docker_runner.py` is a run-to-completion batch shape (sentinel-parsed stdout after exit) with no detached boot/health/teardown path; the browser sidecars are dev-only and not co-deployed with the fleet; Jace and the fleet communicate ONLY through console HTTP.
4. `jace.preview` and "detected recipe" exist nowhere; the only command detector (`agentrail/runner/onboard.py:220-234`) guesses build/test commands for a memory note and never boots anything.

## Decision

Split the phase where the dependencies split:

- **B2a — Visual evidence (build first, ships alone).** Build the artifact-storage seam from zero (it is greenfield, not "the seam the console already runs"), teach QA to capture per-AC screenshots, extend the QA output contract to carry artifact references, and make the posted review link them. Works immediately on rung-1 (preview-URL) PRs — the owner's #1564 ruling lands without waiting for the sandbox.
- **B2b — Sandbox boot (builds on B2a's evidence pipe).** A boot service on the fleet side gives no-preview PRs something to browse, with a topology that matches the deploys we actually have — child-process boot + Railway private networking — and honesty about its isolation level, upgradeable to the docker tier when socket feasibility is verified.

## Design — B2a: the visual-evidence pipe

### 1. Artifact storage (console, greenfield)

- New module `apps/console/lib/artifacts/store.ts`: a minimal S3-compatible client (the `@aws-sdk/client-s3` dependency is NEW — nothing else in the repo provides one) configured from the existing-but-unread `S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY/S3_BUCKET` env (dev compose already runs minio with bucket `agentrail-artifacts`; prod: Railway minio service or any S3 — the env contract finally gets its reader). Two functions: `putArtifact(key, bytes, contentType)` and `signedGetUrl(key, ttlSeconds)` (presigned GET — the repo's first; GitHub's comment-upload CDN has no public API, so links in reviews are console-signed URLs).
- Key scheme (the #1564 ruling verbatim): `review-evidence/<workspaceId>/<repo>/<prNumber>/<headSha>/<acId>/<n>.png`.
- New route `POST /api/v1/runner/review-evidence` — auth `requireJaceConsoleSecret`; body `{eveSessionId, repo, prNumber, headSha, acId, imageBase64, contentType}`; resolves workspace through the SAME session chain every runner route uses (identity-less sessions supported since #1569); size cap 2MB/image, count cap 4/AC; returns `{key, url}` (signed, 30-day TTL v1). A `GET /api/v1/runner/review-evidence?key=` re-signer exists for later consumers (Arc D).
- `review_jobs` gains a nullable `evidence_keys jsonb` column (migration — recompute filename/idx live per the journal gotcha) written at `complete` with whatever keys the job's summary carried — the Arc D attachment point.

### 2. QA captures per-AC (jace)

- `QA_SCHEMA.ac_results[*]` gains optional `evidence_images: string[]` (signed URLs returned by the upload tool; cap 4, additive — `validateAdvisory` treats absence as today).
- New QA tool `upload_evidence_image` (`apps/jace/agent/subagents/qa/tools/`): takes `{acId, imageBase64, contentType}` plus the PR coordinates root passed in the task prompt; calls the new console route with the session-chain auth every sibling tool uses (`ctx.session.parent?.rootSessionId ?? ctx.session.id`). QA's sentinel-stripped harness stays otherwise untouched.
- `qa/instructions.md`: the Exercise protocol adds — after each behavioral AC's decisive observation, take a screenshot with the browser connection's screenshot tool, upload it via `upload_evidence_image`, and put the returned URL in that AC's `evidence_images`; failing ACs capture the FAILING state; `not_testable` captures nothing and says why. Prose-pinned like all QA rules.

### 3. The posted review links pixels (jace)

- `post_pr_review`'s rendering (`post_pr_review.core.mjs`): when a folded QA `ac_results` entry carries `evidence_images`, the per-AC line renders trailing markdown links `[evidence 1](url)…` (plain links v1 — signed URLs in `<img>` embeds expire visually; links degrade gracefully). The count line and judgment fold rules are untouched.
- Root's relay rules and the review-job prompt gain one sentence each: evidence images ride the QA fold verbatim.

## Design — B2b: the sandbox boot

### 4. Topology ruling (resolves the exploration's hard contradictions)

**v1 boots are a child process on the fleet box** — not a Docker sibling — because that is the substrate that exists: the fleet already runs untrusted repo code as child processes under disposable-directory hygiene (its own README's words), the docker tier is off by default everywhere, and Railway socket support is unverified. The spec says this honestly: **a boot inherits the fleet's existing posture — hygiene, not a hard security boundary** — and the hard-isolation upgrade path (the docker tier, or Railway ephemeral services) is a follow-up gated on the same `AGENTRAIL_SANDBOX=docker` feasibility question the fleet already documents. What v1 DOES guarantee: public-safe env only (the boot env is built by the EXISTING `filter_docker_sandbox_env`-style allowlist in `native_runner.py:1064-1095` — never workspace secrets, never console tokens), CPU/time caps, and unconditional teardown.
- **Reachability:** the browser sidecars join the hosted deploy as Railway services on the **private network** (they are plain MCP-over-HTTP containers; Jace's QA connection URLs are already env-configurable — `JACE_AGENT_BROWSER_MCP_URL`/`JACE_BROWSER_USE_MCP_URL`). The boot binds `0.0.0.0:<assigned port>` on the fleet service; QA browses `http://<fleet>.railway.internal:<port>`. Nothing is ever exposed publicly. Dev mirrors this with the compose network that already exists.

### 5. The boot lifecycle (fleet + console — the only Jace↔fleet channel is console HTTP)

- New work-item kind `"preview"` riding the PROVEN extension point (`WorkItem.kind`, `runner.py:48-59`'s onboard precedent): console enqueues a preview work item; the fleet claims it, clones the PR head (reusing `clone_auth.py`), detects the run recipe, boots, health-checks, and reports.
- New console routes (auth as the runner surface): `POST /api/v1/runner/preview-boots` (Jace requests: `{eveSessionId, repo, prNumber, headSha}` → creates row keyed like review jobs, enqueues), `GET /api/v1/runner/preview-boots/:id` (Jace polls: `pending|booting|ready{url}|failed{reason}|torn_down`), fleet-side claim/report mirrors the work-item loop. TTL: a ready boot lives 20 minutes or until the review job completes, whichever first; teardown is the fleet killing the process group + deleting the directory, always.
- **Recipe detection** (new pure module beside `onboard.py`'s precedent, extending it to serve commands): explicit `.agentrail/config.json` key **`preview`** (`{install, start, port, readyPath}` — the name `jace.preview` from the directional text dies; config keys live flat like `verify`/`acProofGate`) → else detection: `package.json` `dev`/`start` script + default port heuristics; anything undetectable → boot `failed{reason}` → the affected ACs are rung-3 `not_testable` with that reason, recorded.
- The review-job prompt's rung ladder gains rung 2: no preview URL → root requests a boot via a new `request_preview_boot` root tool (console-backed, same session auth), polls briefly, hands the ready URL to QA exactly as rung 1; boot logs' tail attaches to the artifact trail via the B2a evidence route (text file, same key scheme, `boot.log`).

## Contradictions resolved (exploration 2026-08-02 — ten findings)

1. Fleet "isolation tier" ≠ reality → §4's honest child-process ruling + upgrade path.
2. `jace.preview`/recipe fiction → flat `preview` config key + real detector module (§5).
3. "Reachable only from the sidecar" had no network story → Railway private networking + env-configurable sidecar URLs (§4).
4. "S3/minio seam the console already runs" was dead config → B2a builds the reader/writer from zero (§1); the unrelated `lib/evidence` system is left alone and the name collision is called out in code comments.
5. No signed-URL precedent → `signedGetUrl` is the repo's first, in the new store module (§1).
6. `QA_SCHEMA`/`review_jobs` can't carry artifacts → additive `evidence_images` + `evidence_keys` columns (§1, §2).
7. Capture already allowlisted → B2a is instructions + schema + storage, not new browser plumbing (§2).
8. No Jace↔fleet channel → all boot signaling rides new console routes (§5).
9. `docker_runner`'s batch shape can't boot → the boot is a fleet child process with its own lifecycle, reusing `clone_auth` + the env allowlist, NOT `docker_runner` (§4, §5).
10. Rung-1 preview detection is LLM judgment → unchanged, explicitly a non-goal.

## Testing

- B2a: store module unit tests (key scheme, caps, content types; minio in dev compose is the integration target); route tests (auth, session chain incl. identity-less, size/count caps, base64 handling); QA schema/validateAdvisory additive cases; prose pins (capture-per-AC, failing-state, not_testable-captures-nothing); post_pr_review rendering cases (links appended, count line untouched, no-evidence unchanged); one e2e: upload → signed URL fetches bytes.
- B2b: recipe detector unit matrix (explicit config, package.json variants, undetectable); work-item kind claim/report SQL tests (the review_jobs test idioms); boot lifecycle with a fake process (ready, health-fail, TTL teardown, teardown-on-complete); route tests; prompt pins for rung 2; a live smoke on a real PR before any enrollment — the B1 lesson, now doctrine.

## Rollout

B2a first, its own flag `REVIEW_EVIDENCE_ENABLED` (console) — observe on dogfood rung-1 PRs. B2b behind `PREVIEW_BOOTS_ENABLED` + per-workspace enrollment, dogfood on agentrail's own repos, after its live smoke. Deploy additions: minio (or S3 creds) for console; sidecar services + fleet private-network wiring for B2b.
