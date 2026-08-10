# 9codex

Local OpenAI-compatible gateway for Codex Desktop.

9codex keeps Codex on its native Responses API, routes requests through a
configured OpenAI-compatible upstream, and adapts compatible Chat Completions
models when needed. It runs as a per-user local daemon and does not modify the
Codex application bundle, native model cache, or unrelated Codex settings.

## Requirements

- Codex Desktop
- Node.js 24 or newer
- An OpenAI-compatible upstream URL and API key

## Install

```bash
npm install --global @hooliy/9codex
9codex init
```

`9codex init` asks for:

1. upstream base URL
2. API key
3. models to expose in Codex

The package contains no endpoint, API key, or machine-specific configuration.
Credentials are written to `~/.9codex/config.json` with owner-only permissions.

## Commands

```text
9codex init [control-plane-url]
9codex sync
9codex status
9codex models list
9codex models select <model-id...>
9codex models all
9codex skills-sync
9codex install
9codex restart
9codex codex-restart
9codex auth-token
9codex update [exact-version]
9codex version
9codex uninstall
```

`9codex sync` refreshes `/v1/models` from the configured upstream. New models
are discovered automatically. All discovered models are visible by default;
`9codex models select` writes an explicit allow-list.

Changing the upstream URL clears the previous model allow-list. This prevents
models from one relay being presented while another relay is active.

9codex bundles an `orchestrator` skill for non-simple tasks. The main task
confirms requirements, splits conflict-free work across sub-agents, verifies
files, diffs, tests, builds, and actual output itself, then loops failed work
until every completion criterion passes or a hard external blocker is reported.
`9codex init`, `9codex install`, manual updates, and automatic updates sync the
bundled skill before Codex restarts. `9codex skills-sync` only syncs skills; it
requires no upstream configuration and restarts neither 9codex nor Codex.

The daemon checks npm every five minutes. A newer version remains queued while any Codex
task or sub-agent is active, is retried every minute, then installs and restarts
9codex and Codex only after all work is idle. Unknown activity state fails
closed and never triggers a restart.

## Remote control plane

`9codex init https://control.example.com` starts the optional browser
authorization flow. A successful authorization downloads the upstream
configuration and model catalog. The server can revoke authorization at any
time.

The remote API contract is a template in
[`docs/control-plane-api.md`](docs/control-plane-api.md). Remote commands are
allow-listed, sequenced, acknowledged, and never executed as arbitrary shell
commands.

## Protocol compatibility

Each model is profiled from `/v1/models`. 9codex supports:

- native Responses
- Responses-compatible request repair
- Chat Completions fallback
- automatic negotiation when protocol metadata is absent

The local daemon translates requests and streaming events while keeping the
Codex-facing endpoint Responses-compatible.

## Image generation

The bundled MCP server exposes `image_gen`. Requests use the configured image
model through `/v1/images/generations`; the upstream key stays inside the local
daemon.

## Security

- Never commit `~/.9codex/config.json`.
- Never paste API keys into issues or logs.
- Diagnostics redact credentials.
- The loopback gateway rejects requests without the local bearer token.
- Published packages exclude local archives, screenshots, logs, and configs.

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
