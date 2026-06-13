# waydock-pulse

Monorepo for **Pulse**, the open-source watcher CLI.

| Package | Description |
| --- | --- |
| [`@waydock/pulse`](packages/agent) | The watcher CLI — checks, restarts, heartbeats, alerts. |
| [`@waydock/pulse-core`](packages/core) | Shared types and the config/heartbeat schema (zod). |

See [`packages/agent/README.md`](packages/agent/README.md) for usage.

## Development

```bash
npm install
npm run build       # build all packages (in dependency order)
npm test            # run the full vitest suite
npm run typecheck   # tsc -b across the workspace
```

## License

[MIT](LICENSE)
