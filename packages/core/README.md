<img src="https://raw.githubusercontent.com/waydock/pulse/main/logo.svg" alt="Waydock" width="72" height="72">

# @waydock/pulse-core

The contract layer behind [`@waydock/pulse`](https://www.npmjs.com/package/@waydock/pulse):
the zod `Config` schema for `pulse.config.yaml`, the `HeartbeatPayload`,
`AgentStatus` and `Metrics` types the watcher sends, and the `NodeRecord` type
the ingest side stores. Importing it parses and validates; it has no runtime side
effects.

You do not need to install this directly. `@waydock/pulse` depends on it, and it
is published separately so anything that reads or writes a Pulse heartbeat can
share the same schema.

```bash
npm install @waydock/pulse-core
```

Requires Node.js >= 20.

## License

MIT. See [LICENSE](LICENSE).
