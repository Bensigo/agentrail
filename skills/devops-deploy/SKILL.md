# DevOps Deploy

Use this skill when changing CI, deployment, release automation, infrastructure config, containerization, secrets handling, or environment behavior.

## Workflow

1. Identify the deployment surface and the failure mode the change is meant to address.
2. Keep secrets out of committed files and logs.
3. Preserve rollback paths and avoid irreversible migration or release behavior unless explicitly required.
4. Make environment assumptions visible in docs, scripts, or config names.
5. Prefer deterministic checks over manual deployment claims.

## Verification

- Run shell, workflow, config, or build validation commands that can execute locally.
- For CI-only behavior, document the exact workflow path and expected verification signal in the PR.
