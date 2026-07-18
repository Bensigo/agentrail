# Runner image — Claude Code (headless) via OpenRouter

The hosted `agentrail runner` daemon's coding agent is **Claude Code**, invoked
headlessly (`claude --bare -p`), routed through **OpenRouter** using its native
Anthropic-Messages-compatible endpoint. This supersedes an earlier `aider`
choice (below). Issue: #1266 PR ①. Part of epic #1257 (Jace e2e arc) — this is
the runtime the spec names as a **verification item, not an assumption**; PR ②
(a separate task) runs one real issue end-to-end on prod to confirm it.

## The verified env contract

Baked into the image (`Dockerfile`, non-secret):

| Var | Value | Why |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` | OpenRouter's native Anthropic-Messages-compatible endpoint — no shim, no LiteLLM, no custom-agent wrapper. |
| `ANTHROPIC_API_KEY` | `""` (explicitly empty) | Must be empty per OpenRouter's own integration guide, so it never shadows the Bearer credential below. |
| `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` | `1` | Documented by OpenRouter's Claude Code guide as required for the fast-mode org check to not block non-first-party routing. |
| `AGENTRAIL_HOSTED` | `1` | The literal marker `is_hosted_run()` checks (`agentrail/run/pipeline.py`) — enforces #1270's independent-reviewer assert (a hosted run refuses to proceed without a distinct verify-phase model; see `agentrail-config.hosted.json` below). |
| `AGENTRAIL_AGENT` | `claude` | Selects the `claude` agent in `agentrail run`'s registry (`agentrail/cli/commands/run.py:AGENTS`) without needing a `--agent` flag. |
| `AGENTRAIL_CLAUDE_COMMAND` | `claude --bare -p --dangerously-skip-permissions` | The env-override slot for the `claude` agent's command (`ENV_NAMES = {"claude": "AGENTRAIL_CLAUDE_COMMAND", ...}`, read by `resolve_agent_command`). Adds `--bare` for THIS image only — see "Why `--bare` is wired via env, not `DEFAULT_COMMANDS`" below. |

Supplied at **runtime only**, never baked, never logged (`entrypoint.sh`):

| Var | Source | Maps to |
|---|---|---|
| `OPENROUTER_API_KEY` | `deploy/.env` (already the documented name for this service) | `ANTHROPIC_AUTH_TOKEN`, exported by `entrypoint.sh` right before `exec "$@"`. |

`ANTHROPIC_AUTH_TOKEN` is the var Claude Code sends as a Bearer credential
(`Authorization: Bearer <token>`), as opposed to `ANTHROPIC_API_KEY`'s
`X-Api-Key` header — OpenRouter's own Claude Code integration guide
(`openrouter.ai/docs/cookbook/coding-agents/claude-code-integration`, verified
2026-07-18) specifically documents the Bearer/`ANTHROPIC_AUTH_TOKEN` shape with
`ANTHROPIC_API_KEY` left empty.

## Auth mechanism — verified empirically in review (PR② re-confirms against the real endpoint)

**Resolution (independent review, 2026-07-18):** tested against a local HTTP
capture server with the exact shipped env (`ANTHROPIC_BASE_URL` + placeholder
`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=""` + `--bare`): the CLI sends
`Authorization: Bearer <ANTHROPIC_AUTH_TOKEN>` to the configured base URL, and
the empty `ANTHROPIC_API_KEY` does not shadow it (a no-credential control run
refused with "Not logged in" before any network call). The docs/help wording
below does not reflect runtime behavior; kept for the record. PR② re-confirms
once against the real OpenRouter endpoint, then this section collapses to one
line.

The original unreconciled sources, for the record:
Two things are true and, as far as this build environment could establish, not
fully reconciled with each other:

1. `code.claude.com/docs/en/headless.md` states, verbatim: *"Bare mode skips
   OAuth and keychain reads. Anthropic authentication must come from
   `ANTHROPIC_API_KEY` or an `apiKeyHelper` in the JSON passed to `--settings`."*
   The installed CLI's own `claude --help` text for `--bare` says close to the
   same thing: *"Anthropic auth is strictly `ANTHROPIC_API_KEY` or
   `apiKeyHelper` via `--settings` (OAuth and keychain are never read)."*
   Neither text names `ANTHROPIC_AUTH_TOKEN` as a bare-mode-compatible
   credential.
2. OpenRouter's own Claude Code integration guide (the source for the env
   contract above) is written around `ANTHROPIC_AUTH_TOKEN` +
   empty-`ANTHROPIC_API_KEY`, and never mentions `--bare` mode at all.

Neither document explicitly contradicts the other, but together they leave it
genuinely unverified whether `--bare` actually reads `ANTHROPIC_AUTH_TOKEN`
when the base URL points away from `api.anthropic.com`. This could not be
tested while building this image — there is no OpenRouter key in this build
environment, and none should ever be committed here or anywhere else in this
repo. It is exactly what PR②'s first real run settles:

- **Auth succeeds** -> this default is confirmed; nothing further to do.
- **Auth fails (401, or Claude Code falls back to demanding an interactive
  login)** -> the fix is a one-line swap in `entrypoint.sh`: export
  `ANTHROPIC_API_KEY="$OPENROUTER_API_KEY"` instead of `ANTHROPIC_AUTH_TOKEN`,
  and drop the empty-string override. OpenRouter's endpoint is a proxy and may
  well accept either header for the same underlying key — this has not been
  confirmed either way, but the fallback is a one-line change, not a
  re-architecture.

## Why `--bare` is wired via env, not `DEFAULT_COMMANDS`

`agentrail/cli/commands/run.py`'s `DEFAULT_COMMANDS["claude"]` is
`"claude -p --dangerously-skip-permissions"` — shared by every caller that
doesn't override it, including every local developer's own `agentrail run`.
Baking `--bare` into that constant would silently take away local hooks,
CLAUDE.md auto-discovery, and MCP servers from every developer, not just this
container. Instead, this image sets `AGENTRAIL_CLAUDE_COMMAND` (the
per-agent env override `resolve_agent_command` checks before falling back to
`DEFAULT_COMMANDS`), so only processes that inherit *this image's* environment
pick up `--bare`. `--bare` itself is the right posture here specifically
because this runner clones arbitrary target repos — it must never execute
whatever hooks/CLAUDE.md a cloned repo happens to carry
(`code.claude.com/docs/en/headless.md`, "Start faster with bare mode").

## `agentrail-config.hosted.json` — the default config auto-injected into a fresh, unconfigured clone

**Updated by #1267 PR②** — this section previously said this file was "not
copied into a clone by the runner." That gap is now closed:
`agentrail/sandbox/native_runner.py:_inject_hosted_config` writes it into a
freshly cloned repo whenever BOTH are true: this container is hosted
(`AGENTRAIL_HOSTED=1`, baked below) AND the clone has no
`.agentrail/config.json` of its own. A repo that already commits its own
config is left **completely untouched** — BYO config always wins, regardless
of its content. This Dockerfile `COPY`s the file into the image at
`/opt/agentrail/agentrail-config.hosted.json` and points
`AGENTRAIL_HOSTED_CONFIG` at that exact path; the two must move together (a
Dockerfile change here without the matching `COPY`/`ENV` pair breaks the
seam). If the template is somehow missing or unreadable at run time, the
runner prints a loud stderr warning and proceeds WITHOUT injecting anything —
never a silent half-config — so the run reaches whatever verdict it would
have reached anyway (see `_inject_hosted_config`'s own docstring for the full
three-way no-op contract).

Without this, a freshly connected repo with no committed config was
permanently refused by #1270's independent-review assert (no distinct
verify-phase model to resolve) — every claim, forever, burning retry budget
with an identical instant failure each time (see `annex-1267-recon.md` §6 for
the full mechanics of that gap). This closes the common case: the repo still
needs to declare its OWN test/verify command for the Objective Gate to have
any checks at all (see the last paragraph below) — no generic template can
supply that — but it no longer needs to hand-author the model-routing half
just to get past the hosted assert.

Fields, and why:

- `runners.claude.command` is **omitted** — `resolve_agent_command` falls
  through to `AGENTRAIL_CLAUDE_COMMAND` (the image's env) whenever the config
  key is absent/empty, so the image's `--bare` command wins without needing
  to be repeated per-repo.
- `runners.claude.models.execute` = `anthropic/claude-sonnet-5` — a strong,
  current coding model (verified against OpenRouter's live public model
  catalog, `openrouter.ai/api/v1/models`, 2026-07-18; this is also the exact
  model this session itself runs on).
- `runners.claude.models.verify` = `z-ai/glm-5.2` — **must be distinct from
  `execute`** (#1270's hosted assert: a hosted run refuses to proceed at all
  unless the Independent Verifier resolves to a different model —
  `agentrail/run/pipeline.py:is_hosted_run()` + `_run_pipeline`'s step 9a).
  DeepSeek was the brief's other suggested option and DOES exist on OpenRouter
  (`deepseek/deepseek-chat`, `deepseek/deepseek-v4-*` — an earlier claim here
  that it was absent was wrong; corrected in review). GLM stays as the verify
  seat on its own merits: live, ~6-10x cheaper than the execute model, and
  distinct — swapping to a DeepSeek id later is a one-line config change.
- `runners.claude.models.critic` = `~anthropic/claude-haiku-latest` — cheap,
  opt-in advisory reviewer (#977). The leading `~` is genuinely part of
  OpenRouter's id for this entry (a rolling "latest" alias; no separately
  pinned Haiku id was found in the current catalog). Safe to pass through
  `agentrail`'s command-building path: `append_model_to_command` shell-quotes
  the model token with `shlex.quote()` before it reaches `bash -lc`, so the
  leading `~` cannot trigger shell tilde-expansion.
- `budgets.per_issue_usd` is **deliberately absent**. #1269 already gives every
  run a product-default cap ($10, `DEFAULT_PER_ISSUE_BUDGET_USD`) when this
  key is unset — hardcoding a number here would fight the future
  task-type-aware cost estimate that #1274 (alignment gate) and #1275
  (per-task model suggestion) are planned to introduce per-run, not
  per-repo-config. Leave it to those defaults/estimates rather than pin a
  number this PR has no real basis for.

A target repo also needs its own top-level `verify` key (a shell command the
Objective Gate runs — see this repo's own `.agentrail/config.json` for the
shape) for the gate to have any checks at all; without one it is always red
(`agentrail/evals/runner.py`'s own comment on `_seed_agentrail_config` says as
much). That is a per-repo concern, not something this template can supply
generically — PR②'s test repo needs one.

## Prompt-caching variance (cost model input)

Per the brief's docs research (2026-07-18): Anthropic models routed through
OpenRouter honor `cache_control` (cached reads price at ~0.1x); DeepSeek/GLM
apply caching automatically; Qwen needs an explicit `cache_control` block to
get it at all. This means the `execute` phase (Anthropic, cache-aware) and the
`verify`/`critic` phases (GLM/Haiku) do not behave identically under repeated
near-duplicate prompts — cost estimates for this runner should not assume a
single flat cache-hit rate across phases.

## Supersedes: why this replaced aider

The prior `deploy/runner/Dockerfile` picked `aider` (via the `--agent custom`
escape hatch + a stdin-to-`--message-file` bridge script) because, at the
time, none of `agentrail`'s four built-in agent CLIs (`codex`/`claude`/
`cursor`/`hermes`) had a verified OpenRouter path — `codex`'s OpenRouter
support was blocked on wire-format mismatch (Responses API only), and `claude`
was believed to only speak Anthropic's own Messages API with no
OpenRouter-compatible endpoint. That aider wiring was explicitly flagged
**"UNVERIFIED END TO END"** (no Docker in that build environment) and was
never run against a real issue.

This is now known to be wrong for `claude`: OpenRouter ships a native
Anthropic-Messages-compatible endpoint specifically so Claude Code doesn't
need a shim. `aider-stdin-wrapper.sh` and its `ENV AGENTRAIL_CUSTOM_COMMAND`
wiring are removed; `AGENTRAIL_AGENT` now selects the built-in `claude` agent
directly. The `codex` OpenRouter blocker (Responses-API-only wire format) is
unchanged and out of scope here.

## How PR② will run the E2E

PR② (a separate task) will:

1. Point a test repo's `.agentrail/config.json` at this template's shape (or a
   copy of `agentrail-config.hosted.json`), plus its own `verify` key.
2. Build this image and run it against that repo, e.g.
   `docker compose run --rm runner agentrail run issue <N> --agent claude
   --target <cloned test repo>` or via the real queue-claim path
   (`agentrail runner --once`, `deploy/README.md`'s existing runbook).
3. Confirm: a green Objective Gate + PR (AC1), a per-phase cost ledger with
   the configured models showing up in run records (AC2), and that a bad key
   or unavailable model surfaces as a run failure rather than a hang (AC3).
4. Re-confirm the (review-verified) auth mechanism against the real endpoint as its very first
   observation, before anything else in the run is trusted.

## Smoke-tested for this PR (offline, no OpenRouter calls)

Docker was available in this build environment, so this went further than a
read-through — an actual image was built and run:

```
docker build -f deploy/runner/Dockerfile -t agentrail/deploy-runner:smoketest .
```

Full build, no cache-busting tricks. Result: builds clean end to end (apt/gh
install, `pip install --break-system-packages .` for `agentrail`, `npm
install -g @anthropic-ai/claude-code@2.1.214`). Docker's own linter prints one
warning (`SecretsUsedInArgOrEnv` on the `ANTHROPIC_API_KEY` line) — addressed
with a comment at that line in the Dockerfile: the value is the empty string
by design, not a secret.

Ran inside the built image:

| Check | Result |
|---|---|
| `claude --version` | `2.1.214 (Claude Code)` — matches the pin exactly |
| `node --version` | `v22.23.1` — satisfies the package's `>=22.0.0` engines requirement |
| `agentrail --help` | prints usage, lists `--agent codex\|claude` |
| `python3 -c "import agentrail.cli.main"` | imports cleanly |
| `docker run --rm <image> env` (no runtime secrets) | carries exactly `AGENTRAIL_AGENT=claude`, `AGENTRAIL_CLAUDE_COMMAND=claude --bare -p --dangerously-skip-permissions`, `AGENTRAIL_HOSTED=1`, `ANTHROPIC_API_KEY=` (empty), `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1`; **no `ANTHROPIC_AUTH_TOKEN` present** |
| `docker run --rm -e OPENROUTER_API_KEY=<fake placeholder, not a real key> <image> env` | confirms `runner-entrypoint` maps it to `ANTHROPIC_AUTH_TOKEN=<same value>`, `ANTHROPIC_API_KEY` stays empty (not overwritten) |
| missing `GITHUB_TOKEN`/`OPENROUTER_API_KEY` at runtime | both print the expected `runner-entrypoint: WARNING —` line to stderr and continue (fail-open, not a crash) |

No call to OpenRouter itself was made or attempted — there is no key in this
environment, and this PR does not write one anywhere. The `OPENROUTER_API_KEY`
value used above is an obvious placeholder string used only to prove the
entrypoint's env-to-env mapping copies a value across; it never leaves the
container and nothing was sent over the network. The actual authenticated
call to OpenRouter is PR②'s
job.
