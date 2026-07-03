# Jace

Jace is the coordinator for the AgentRail factory. It owns the ideation→issues
boundary: a human converses with Jace about an idea, and when the human approves,
Jace creates exactly ONE GitHub issue in the AgentRail "house format". The
AgentRail factory then picks that issue up on its own — it polls GitHub for the
trigger label — with zero Jace-side plumbing.

Jace is built on [Eve](https://github.com/vercel/eve) and runs as a self-hosted
HTTP sidecar.

## Topology

- Jace runs as an Eve self-hosted sidecar on `http://127.0.0.1:2000`.
- HTTP surface: `GET /eve/v1/health`, `POST /eve/v1/session`,
  `POST /eve/v1/session/:id`, `GET /eve/v1/session/:id/stream` (NDJSON).
- Jace has exactly ONE way to act on the outside world: the human-gated
  `create_issue` tool. Every call to it is approved or rejected by a human before
  it runs (`approval: always()`).
- `create_issue` shells out to the existing `agentrail issue create` CLI
  (connector mode → a direct GitHub issue create). This is the single write path
  into the factory. The `ready-for-agent` trigger label is applied server-side by
  the CLI; Jace never passes labels.

There is no second write path. Jace never merges pull requests, runs the factory,
or triggers builds.

## Requirements

- Node.js `>= 24` (the tests use Node's built-in `node --test`).
- An installed `agentrail` CLI on `PATH` (or point `JACE_AGENTRAIL_BIN` at it),
  co-located with the operator's AgentRail install.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `VERCEL_OIDC_TOKEN` or `AI_GATEWAY_API_KEY` | Authenticates the model. `agent.ts` uses the string model id `anthropic/claude-sonnet-4.6`, which routes through the Vercel AI Gateway. A bare `ANTHROPIC_API_KEY` is IGNORED on that path. |
| `GITHUB_OAUTH_TOKEN` or `GITHUB_TOKEN` | Auth for the CLI's `github` connector when creating the issue. |
| `JACE_TARGET_REPO` | Default `owner/repo` the created issue lands in (the `create_issue` tool falls back to this when `repo` isn't supplied). |
| `JACE_AGENTRAIL_BIN` | Optional override for the `agentrail` binary. Defaults to `agentrail`. |
| `EVE_HOST` | Base URL used by the round-trip harness. Defaults to `http://127.0.0.1:2000`. |

## Install

This app is DELIBERATELY excluded from the root pnpm workspace and installs
standalone. The dependency pins are exact (see the `//pins` note in
`package.json`) because Eve is pre-1.0 and churns fast.

```bash
cd apps/jace
npm ci
```

## Run

Start the sidecar in one shell:

```bash
npm run dev        # runs `eve dev` on http://127.0.0.1:2000
```

Then, in another shell, drive the human-gated approval round-trip:

```bash
npm run roundtrip  # runs the approve + reject arms against the running sidecar
```

The round-trip harness exercises both arms end to end: approving creates a real
issue and returns its URL; rejecting creates no issue and the conversation
continues.

## Unit tests

The pure issue-building/parsing core is unit-tested with zero extra
dependencies:

```bash
npm test           # node --test test/
```

## Persona

Jace's persona/system prompt is a reviewable artifact at
[`agent/instructions.md`](agent/instructions.md), loaded by Eve's filesystem
convention. The issue-shaping skill lives at
[`agent/skills/emit-issue-brief/SKILL.md`](agent/skills/emit-issue-brief/SKILL.md).

## Hosting

See [`docs/HOSTING.md`](docs/HOSTING.md) for the hosting decision.
