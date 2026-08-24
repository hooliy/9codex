# 9codex Control Plane API Template

All endpoints use JSON over HTTPS. Agent endpoints require `Authorization: Bearer <access_token>` and `X-9codex-Installation-ID`. A CLI authorization has no natural expiry; its refresh token remains valid until the server revokes the authorization.

## Create CLI authorization

`POST /v1/cli/authorizations`

```json
{
  "client": "9codex-cli",
  "client_version": "3.0.0",
  "installation_id": "ins_123",
  "device_name": "DESKTOP-EXAMPLE",
  "platform": "windows",
  "redirect_uri": "http://127.0.0.1:24567/callback",
  "code_challenge": "base64url-sha256-pkce-challenge",
  "code_challenge_method": "S256"
}
```

```json
{
  "request_id": "req_123",
  "authorization_url": "https://api.example.com/authorize?request_id=req_123",
  "expires_in": 600
}
```

## Exchange authorization code

`POST /v1/cli/tokens`

```json
{
  "request_id": "req_123",
  "authorization_code": "code_123",
  "code_verifier": "original-base64url-pkce-verifier",
  "installation_id": "ins_123"
}
```

```json
{
  "authorization_id": "auth_123",
  "access_token": "sat_123",
  "access_token_expires_in": 3600,
  "refresh_token": "srt_123",
  "refresh_token_expires_at": null
}
```

## Refresh access token

`POST /v1/cli/tokens/refresh`

```json
{
  "authorization_id": "auth_123",
  "refresh_token": "srt_123",
  "installation_id": "ins_123"
}
```

```json
{
  "access_token": "sat_456",
  "access_token_expires_in": 3600
}
```

A revoked authorization returns HTTP 401:

```json
{"error":{"code":"authorization_revoked","message":"This CLI authorization was revoked."}}
```

## Bootstrap configuration

`GET /v1/agent/bootstrap`

The client sends `If-None-Match: "<current revision>"`; return HTTP 304 when unchanged.

```json
{
  "revision": "cfg_000002",
  "catalog_revision": "models_000008",
  "upstream": {
    "base_url": "https://router.example.com/v1",
    "api_key": "sk-example",
    "default_model": "yuanpi-auto",
    "image_model": "cx/gpt-5.5-image"
  },
  "models": [
    {
      "id": "yuanpi-auto",
      "display_name": "YuanPi Auto",
      "enabled": true,
      "protocol": "responses_native",
      "context_window": 128000,
      "capabilities": {
        "streaming": true,
        "tools": true,
        "parallel_tools": true,
        "reasoning": true,
        "reasoning_levels": ["low", "medium", "high"],
        "image_input": true,
        "structured_output": false
      },
      "compatibility": {
        "strip_request_fields": [],
        "rename_request_fields": {}
      }
    }
  ],
  "updates": {
    "channel": "stable",
    "latest_version": "3.0.1",
    "minimum_version": "3.0.0",
    "npm_package": "@hooliy/9codex",
    "npm_registry": "https://registry.npmjs.org"
  },
  "commands": {
    "events_url": "/v1/agent/events",
    "heartbeat_interval_seconds": 60
  }
}
```

`protocol` supports `responses_native` and `responses_compat`. Models without an
explicit protocol use `responses_native`. `chat_compat` is rejected because Chat
Completions cannot preserve Codex custom tools, MCP namespaces, or native
multi-agent namespaces.

## Heartbeat

`POST /v1/agent/heartbeat`

```json
{
  "installation_id": "ins_123",
  "ninecodex_version": "3.0.0",
  "service_status": "running",
  "codex_version": "26.727.6591.0",
  "config_revision": "cfg_000002",
  "catalog_revision": "models_000008",
  "active_model": "yuanpi-auto",
  "platform": "windows"
}
```

## Command events

`GET /v1/agent/events` uses `text/event-stream`.

```text
event: command
id: cmd_000001
data: {"command_id":"cmd_000001","sequence":1,"type":"service.restart","issued_at":"2026-08-01T08:00:00Z","expires_at":"2026-08-01T08:10:00Z","payload":{}}
```

Allowed types are `config.refresh`, `models.refresh`, `service.restart`,
`package.update`, and `diagnostics.collect`. The API must never send shell text,
write Codex files, or restart Codex.

## Command acknowledgement

`POST /v1/agent/commands/{command_id}/ack`

```json
{
  "installation_id": "ins_123",
  "status": "succeeded",
  "started_at": "2026-08-01T08:00:02Z",
  "finished_at": "2026-08-01T08:00:05Z",
  "result": {
    "service_restart_requested": true
  }
}
```

Statuses are `received`, `running`, `succeeded`, `failed`, and `rejected`.
