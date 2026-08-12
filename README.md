# 9codex

Persistent software team and local OpenAI-compatible gateway for Codex.

9codex maps each user-created Codex conversation to one durable TaskGroup.
Later messages become immutable demand events and requirement revisions.
The background Orchestrator plans work, runs isolated Codex workers, supervises
leases and checkpoints, independently verifies evidence, reworks failures, and
recovers unfinished tasks after restart. The same daemon also keeps Codex on its
native Responses API and routes models through an OpenAI-compatible upstream.

9codex does not modify the Codex application bundle, native model cache,
database, rollout history, or unrelated Codex settings.

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
9codex taskboard
9codex tasks list
9codex tasks show <task-group-id>
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

9codex bundles an `orchestrator` skill for non-simple tasks. The skill submits
the current user conversation and its later changes to the persistent local
Orchestrator API. Internal WorkerSession records remain hidden by default.
`9codex taskboard` prints the authenticated local Taskboard URL.
`9codex tasks list` and `9codex tasks show` provide JSON diagnostics.

The Taskboard shows task groups, requirement revisions, DAG state, running
workers, blockers, evidence, and final reports. It refreshes every two seconds.
The local API listens only on loopback and requires a private bearer token.
When Codex Desktop is launched by `9codex install` or `9codex codex-restart`,
9codex dynamically adds a `任务中心` sidebar entry through the loopback Codex
renderer debugging session. The bridge never modifies the application bundle
and falls back to `9codex taskboard` when the renderer UI changes.

Each accepted WorkItem requires evidence from a distinct Reviewer Run. Worker
self-reports cannot close work. Failed verification returns work to rework;
repeated identical failures become a real blocker. Up to three conflict-free
workers run in isolated Git worktrees.

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
- The loopback Taskboard API rejects requests without its separate bearer token.
- Worker commands use argv without a shell and default to workspace-write.
- Artifacts, evidence, checkpoints, and SQLite state use user-private paths.
- Production and irreversible actions still require explicit user authorization.
- Published packages exclude local archives, screenshots, logs, and configs.

## Persistent team storage

```text
~/.9codex/team.sqlite
~/.9codex/artifacts/
~/.9codex/backups/
```

SQLite uses WAL, foreign keys, a busy timeout, versioned migrations, optimistic
locks, one active WorkItem lease, one running Run per WorkerSession, atomic
event/outbox writes, and migration backup restoration.

Product scope and acceptance criteria:
[`docs/persistent-team-product.md`](docs/persistent-team-product.md).

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
