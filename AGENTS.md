# Operating contract for agents

## Product authority

The canonical product model is the trust-layer MVP defined by [ADR 0012](docs/adr/0012-jace-owns-the-acceptance-spine.md)
and [the migration ledger](docs/trust-layer-migration-ledger.md). They take
precedence over older factory-oriented copy, plans, generated artifacts, and
historical terminology.

Jace owns the acceptance contract, bounded Context Pack, exact-head evidence,
blocking correction, and final human decision. External builders such as Codex
and Claude Code implement confirmed work. Jace never silently edits code or
merges. Exact-head proof and evidence-bound blocking correction are the
product; a test, queued job, attempted delivery, or page-load check is not
proof by itself.

## Legacy infrastructure boundary

The `agentrail/` factory and its queue/runner/Objective Gate vocabulary remain
valid technical infrastructure and historical migration evidence where code
still uses them. They are not the public trust-layer MVP. Do not describe Jace
as the executor or implementation owner, or imply that he opens PRs. Do not
delete legacy code or historical records merely to make the current framing
cleaner.

## Working rules

- Read `CONTEXT.md`, ADR 0012, and the relevant migration-ledger section before
  non-trivial work.
- State implemented, code-existing, and live-verified evidence separately.
- Preserve unrelated user changes and keep edits within the requested scope.
- For UI-visible work, use browser evidence when requested; for other work,
  run the smallest meaningful objective check.
- Do not claim a live builder pickup, runtime proof, notification, merge, or
  deployment without direct evidence.
