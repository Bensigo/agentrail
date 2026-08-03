# One-click connector smoke evidence

Date: 2026-08-03

This is a sanitized local proof record for the disposable OAuth/MCP smoke test.
No real provider account, credential, access token, or refresh token was used
or recorded.

## Scenario

- Disposable owner: `codex-smoke@example.invalid`
- Disposable workspace: `codex-smoke-workspace`
- Connector: Linear
- OAuth client/provider: local fake provider
- Browser flow: Connectors page → `Connect Linear` → fake consent → callback

## Observed results

The browser returned to:

```text
http://localhost:3100/dashboard/00000000-0000-4000-8000-000000000002/connectors?connected=linear
```
The fake MCP endpoint returned:

```json
{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"search_read","annotations":{"readOnlyHint":true}},{"name":"update_write","annotations":{"destructiveHint":false}}]}}
```

The database assertion after callback was:

```text
linear|t|t|f|t
```

Fields are `provider|enabled|secret_is_not_null|oauth_state_present|pkce_verifier_present`.
The secret value was not selected. The legacy runner path excludes OAuth
envelopes rather than treating the envelope JSON as an API key.

Cleanup verification after the smoke test:

```text
0|0|0
```

Fields are `user_rows|workspace_rows|session_rows` for the disposable IDs.

## Automated proof

```text
Console focused suite: 257 passed
db-postgres connector suite: 37 passed
Jace researcher suite: 12 passed
```
