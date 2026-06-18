# @waydock/pulse

Open-source watcher CLI. It runs checks against your processes, restarts them
when they die, persists state across restarts, and sends heartbeats and alerts.

```bash
npm install -g @waydock/pulse
```

Requires Node.js >= 20.

## Quick start

```bash
pulse init      # write a starter pulse.config.yaml
pulse login     # authenticate this machine (device flow) -> ~/.pulse/credentials.json
pulse check     # evaluate all agents once and print a status table (no restarts, no network)
pulse start     # run the watch + heartbeat loops in the foreground
```

All commands accept `--config <path>` (default: `./pulse.config.yaml`).

## Configuration

`pulse.config.yaml`:

```yaml
node: my-server            # unique name for this machine

heartbeat:
  url: https://ingest.waydock.ai/api/pulse/heartbeat
  # key is loaded from ~/.pulse/credentials.json after `pulse login`
  interval: 60             # seconds between heartbeats (also the check interval)

defaults:
  retries: 3               # restart attempts before giving up
  confirm: 2               # consecutive failed checks before marking an agent down

# Optional: local alert webhook (Discord webhook URLs are auto-detected)
webhook:
  url: https://discord.com/api/webhooks/...

# Optional: which system metrics to collect (all default to true)
metrics:
  cpu: true
  mem: true
  disk: true

agents:
  - name: my-process
    checks:
      - process: my-process-name      # substring match against `ps` output
      # - http: http://localhost:8080/health   # passes when the response is 2xx
      # - command: systemctl is-active myservice  # passes when exit code is 0
    # Optional restart command. Omit (or set `restart: false`) for alert-only.
    restart: launchctl kickstart -k gui/$(id -u)/com.example.myservice
    # retries / confirm override the defaults block per-agent
```

`${ENV_VAR}` references in the config are interpolated from the environment at
load time (a missing variable is a hard error).

## How it works

- **Checks** — an agent is `up` only when *all* of its checks pass. A `process`
  check substring-matches `ps` output, `http` passes on a 2xx response, and
  `command` passes on exit code 0.
- **Confirm** — an agent is marked `down` only after `confirm` consecutive
  failures, to avoid flapping.
- **Restart** — on a down transition, the `restart` command runs with backoff up
  to `retries` times; a passing recheck in between counts as recovered.
- **Heartbeat** — runs on its own independent timer, so a slow restart can never
  delay or block a heartbeat. Network failures are swallowed (best-effort).
- **State** — agent status is persisted atomically to `~/.pulse/state.json` so a
  process restart does not re-fire alerts for agents already known to be down.

## Security / trust model

`command` checks and `restart` commands are executed via `/bin/sh`. They come
from *your* local config file, so treat `pulse.config.yaml` as trusted input and
restrict who can write to it. Credentials are stored at
`~/.pulse/credentials.json` with `0600` permissions.

## License

MIT
