# 9codex

Headless background daemon and OpenAI-compatible gateway for Codex.

9codex enhances Codex without patching Codex. It owns only `~/.9codex`, runs as
a supervised background service, routes model requests, enables Fast by default,
and exposes optional local MCP tools. Complex independent work uses Codex native
sub-agents in parallel. There is no external task orchestrator and no 9codex UI.

## Hard boundaries

9codex never modifies:

- the Codex/ChatGPT application bundle
- `~/.codex/config.toml`
- Codex databases, task history, sessions, or rollouts
- Codex model caches or native model metadata
- Codex update files or renderer DOM

`9codex app` generates a private wrapper in `~/.9codex` and points the current
user's `CODEX_CLI_PATH` to it. Windows uses the user environment; macOS uses the
user launch environment. The wrapper injects Codex CLI `-c` overrides only when
Desktop starts `app-server`; it never edits Codex files. Uninstall removes that
environment value only when 9codex still owns it.
Existing Codex history remains in the original `CODEX_HOME`.

## Requirements

- Codex Desktop on Windows or macOS
- Node.js 24 or newer
- an OpenAI-compatible upstream URL and API key

## Install

```bash
npm install --global @hooliy/9codex
9codex init
```

`9codex init` configures the upstream in `~/.9codex/config.json`, builds the
private model catalog, and installs the headless daemon as a login service.
Credentials remain owner-readable only.

Launch Codex through the daemon:

```bash
9codex app
9codex app /absolute/workspace/path
```

`9codex install`, `9codex restart`, and automatic updates stay headless. They do
not open or navigate Desktop. Use `9codex app` explicitly; `--open` is an
explicit opt-in for install/restart.

The Desktop launch environment points to the 9codex-owned wrapper. It supplies
the 9codex provider, live model catalog, MCP, native multi-agent, Fast, high
reasoning, high verbosity, detailed reasoning summary, and per-model automatic
compaction at 90% of the declared context window. Fixed prompt prefixes do not
count toward that threshold. A running Desktop process is restarted once only
when its app-server is not already using the 9codex catalog.

## Default execution policy

- Simple task: execute directly in the current Codex task.
- Complex task with independent work: use Codex native sub-agents in parallel.
- External persistent Orchestrator: absent.
- Taskboard, sidebar injection, renderer bridge, dashboard: absent.
- Fast: enabled by default for every GPT request through
  `service_tier: "priority"`.
- Non-GPT models: forwarded without an invented service tier.

Fast reduces supported upstream inference latency. It cannot make an upstream
that ignores `priority` compute faster.

## No artificial limits

9codex does not impose:

- model-controlled goal budgets; `create_goal.token_budget` is removed from tool schemas, requests, and responses
- context-window fallbacks
- output-token caps
- request-body size caps
- lower-than-native response truncation caps
- context-window discounts
- worker duration caps

Declared upstream context and output limits are preserved exactly. A model
without the context metadata required by Codex is rejected instead of receiving
an invented limit. Codex-required truncation metadata uses the full declared
context window.

## Gateway behavior

- Native Responses requests stay on Responses.
- Responses-compatible models receive only declared compatibility repairs.
- Chat-only models are rejected because Chat translation cannot preserve Codex native tools.
- Native Responses streams pass through incrementally; only the `9codex` MCP namespace is bridged for flat-tool upstreams.
- Upstream connections use Node's pooled `fetch` transport.
- The loopback gateway requires a private bearer token.
- `/healthz` reports readiness and active request count for safe daemon updates.
- Readiness requires a validated, non-empty model catalog; `model_count` must be
  at least one before installation or Codex launch succeeds.

## Commands

```text
9codex init [control-plane-url]
9codex sync
9codex install
9codex app [workspace]
9codex status
9codex models list
9codex models select <model-id...>
9codex models all
9codex restart
9codex auth-token
9codex update [exact-version]
9codex version
9codex uninstall
```

`9codex sync` refreshes the upstream model catalog. Model selection changes only
9codex-owned state. It never rewrites Codex configuration.

`9codex uninstall` removes the background service. No Codex restoration step is
needed because Codex files were never changed.

## Automatic updates

The daemon checks npm every five minutes. A newer version remains queued while
the gateway has active requests. Unknown activity fails closed. Installation
restarts only the 9codex daemon. `9codex app` may restart Codex Desktop once to
switch an existing app-server to the 9codex integration.

## Image generation

The process-scoped MCP server exposes `image_gen`. Requests use the configured
image model through the authenticated loopback gateway. The upstream API key
stays inside the daemon.

## Remote control plane

`9codex init https://control.example.com` starts optional browser authorization.
Remote commands are typed and allow-listed. They may refresh 9codex config,
models, service state, package version, or diagnostics. They cannot execute
arbitrary shell commands, write Codex configuration, or restart Codex.

See `docs/control-plane-api.md`.

## Security

- Never commit `~/.9codex/config.json`.
- Never paste API keys into logs or issues.
- Diagnostics redact credentials.
- Codex launch authentication is resolved by a local command; the bearer token
  never appears in process command-line arguments.
- The daemon listens only on loopback.
- Production and irreversible actions remain subject to Codex native safety and
  approval behavior.

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
