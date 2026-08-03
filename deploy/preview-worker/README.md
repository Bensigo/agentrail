# Preview worker service

This is the Railway service for B2b preview boots. It uses the same image as
the hosted fleet, but runs the dedicated out-of-process worker instead of the
fleet claim loop:

```text
python3 -m agentrail.runner.preview_worker
```

Configure the Railway service with `/deploy/preview-worker/railway.json` as
its Config File Path and leave the Root Directory unset so the Docker build
context is the repository root.

Required runtime variables:

| Variable | Purpose |
| --- | --- |
| `PREVIEW_WORKER_ENABLED=1` | Enables the worker claim loop. |
| `AGENTRAIL_SERVER_BASE_URL` | Console base URL reachable over Railway private networking. |
| `JACE_CONSOLE_TOKEN` | Shared console runner secret. |
| `PREVIEW_ADVERTISE_HOST` | Fleet private `*.railway.internal` hostname advertised to Jace. |

The console service separately requires `PREVIEW_BOOTS_ENABLED=1` and a
workspace id in `PREVIEW_BOOTS_WORKSPACES`. The worker must share the console's
private network and must not expose a public preview domain.
