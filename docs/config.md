# AgentRail Configuration Reference

Configuration lives in `.agentrail/config.json` at the root of your project.

## `context.*`

Settings under the `"context"` key control the context engine.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `context.includeGlobs` | `string[]` | `["**/*"]` | Glob patterns for files to include in the context index. |
| `context.excludeGlobs` | `string[]` | (sensible defaults) | Glob patterns for files to exclude (node_modules, dist, .git, secrets, …). |
| `context.maxFileSizeBytes` | `number` | `262144` | Files larger than this byte limit are skipped during indexing. |
| `context.skipBinary` | `boolean` | `true` | Skip binary files during indexing. |
| `context.respectGitIgnore` | `boolean` | `true` | Honour `.gitignore` rules when walking the file tree. |
| `context.daemonAutoSpawn` | `boolean` | `false` | When `true`, the first cold-path context query silently spawns the warm-index daemon in the background (non-blocking). Subsequent queries will use the fast warm path. Set `false` (the default) to never auto-spawn. |
| `context.secretRedaction.enabled` | `boolean` | `true` | Enable secret redaction. |
| `context.secretRedaction.action` | `string` | `"exclude"` | Action to take on matched secrets (`"exclude"` or `"redact"`). |
| `context.secretRedaction.denyGlobs` | `string[]` | (credential/key patterns) | Glob patterns identifying files that contain secrets and must not be indexed. |
| `context.embedding.mode` | `string` | `"disabled"` | Embedding provider mode (`"disabled"`, `"local"`, `"openai"`, `"custom"`). |
| `context.summary.mode` | `string` | `"disabled"` | Summary provider mode. |

### Example

```json
{
  "context": {
    "daemonAutoSpawn": true,
    "maxFileSizeBytes": 131072,
    "excludeGlobs": [".git/**", "node_modules/**", "dist/**"]
  }
}
```
