<img src="logo.svg" alt="Waydock" width="72" height="72">

# Pulse

Pulse answers one question about the things you run: is anything down, and when
did it break? This repo is the watcher that runs on your own machines. It
evaluates health checks, restarts what has died, and posts a heartbeat on its own
timer, so a machine that goes quiet is itself the alert. Point it at
[Waydock Pulse](https://waydock.ai/docs/pulse) and that heartbeat opens an
incident, pages your channels, and feeds the status page; leave the heartbeat out
and it still watches and restarts locally, alerting through your own webhook.

Everything here is MIT and runs on macOS and Linux.

## Packages

| Package | Description |
| --- | --- |
| [`@waydock/pulse`](packages/agent) | The watcher CLI — checks, restarts, heartbeats, alerts. |
| [`@waydock/pulse-core`](packages/core) | Shared types and the config/heartbeat schema (zod). |

## Install

```bash
npm install -g @waydock/pulse
pulse init
```

`pulse init` walks you through what to watch, how to health-check it, and how to
restart it, then offers to log in, send a verifying heartbeat, and install itself
as a background service. See
[`packages/agent/README.md`](packages/agent/README.md) for the full command
reference and config schema.

## Development

```bash
npm install
npm run build       # build all packages (in dependency order)
npm test            # run the full vitest suite
npm run typecheck   # tsc -b across the workspace
```

### Releasing

Publishing runs from `.github/workflows/publish.yml` on a `vX.Y.Z` tag, using npm
Trusted Publishing (OIDC) rather than a token. Each package is published only if
its version is not already on the registry, so one tag ships whatever changed and
re-runs are safe. Bump the version in the package you changed before tagging.

## License

MIT. See [LICENSE](LICENSE).
