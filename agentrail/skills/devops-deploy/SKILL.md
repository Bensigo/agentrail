---
name: devops-deploy
description: CI, deployment, release automation, infrastructure, containers, secrets, observability, and production operations. Use when the task mentions deploy, CI/CD, GitHub Actions, Docker, environment variables, secrets, release, rollback, or hosting.
---

# DevOps Deploy

Use this skill for CI, deployment, release automation, infrastructure config, containers, environments, secrets, observability, rollback, or production operations.

## Activation Guidance

Activate when the task mentions deploy, CI/CD, GitHub Actions, Docker, infrastructure, environment variables, secrets, release, rollback, hosting, domains, runtime config, or post-deploy verification.

## Context To Inspect

- CI workflows, deployment scripts, environment-specific config, container files, infrastructure definitions, and release docs.
- Required secrets, environment variables, service accounts, permissions, and protected environment rules.
- Build artifacts, deployment target, health checks, observability, alerts, and logs.
- Rollback path, migration ordering, feature flags, and post-deploy smoke checks.

## Constraints

- Never commit secrets or print them in logs.
- Do not assume local environment values match CI or production.
- Avoid irreversible deploy, migration, or infrastructure behavior unless explicitly required and reviewed.
- Preserve rollback paths and document any temporary incompatibility.
- Prefer deterministic local validation over claims about CI-only behavior.

## Verification Requirements

- Run shell, workflow, config, build, or container validation that can execute locally.
- Validate environment/secrets names without exposing values.
- Check CI/CD workflow paths touched and document the expected CI signal.
- For deploy behavior, document rollback and post-deploy verification checks; run them when the environment is available.

## Expected PR Evidence

- Environment and secrets impact summary.
- CI/CD, deploy, rollback, and post-deploy checks considered.
- Commands run locally and CI signals expected remotely.
- Risks, manual steps, or unavailable environment limitations.

## Provenance / Audit

- Local status: AgentRail-authored first-party skill.
- Upstream sources reviewed: Mindrally skills repository at `https://github.com/Mindrally/skills`, candidate path `devops/SKILL.md` observed; Vercel skills CLI at `https://github.com/vercel-labs/skills` reviewed as UX reference only.
- License status: Mindrally repository reported Apache-2.0; Vercel source not audited for content reuse.
- Local changes: added environment/secrets, CI/CD, deploy, rollback, and post-deploy verification requirements.
- Audit notes: no third-party skill text vendored; candidates are references only and must not be hot-installed.
