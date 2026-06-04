# Pulse — Agent Uptime Monitor (v1 Design)

**Date:** 2026-06-04
**Status:** Design — approved decisions, pending spec review
**Repo:** `github.com/smd00/waydock-pulse`
**Hosted at:** `pulse.waydock.ai`
**npm:** `@waydock/pulse` (agent CLI), `@waydock/pulse-core` (shared contract)

---

## 1. Problem

People run AI agents (openclaw, Claude Code, Hermes, etc.) on always-on boxes — Mac
minis, cloud VPSes. Agents crash. The box itself can also die (power cut, network drop,
kernel panic, freeze). A purely local watchdog has a fatal blind spot: **it cannot report
its own death** — when the box goes, the watchdog goes silent with it.

Pulse solves both failure classes and is meant to be handed to non-experts ("people who
run AI agents, technical or not") who set up personal agents on their own hardware.

| Failure class | Example | Who can detect it |
|---|---|---|
| **Agent-level** | openclaw crashed, box is fine | The local **agent** (check + restart + alert) |
| **Host-level** | power out, network down, box frozen | The **receiver**, by noticing the heartbeat *stopped* |

The core insight: **host-level failure can only be caught off-box, as the absence of a
heartbeat. Silence is the alarm.**

---

## 2. Scope (v1)

### In scope
- **Agent** (`npx @waydock/pulse`): a long-running watcher that, every interval:
  1. checks each configured agent (up/down),
  2. restarts the dead ones (with retries/backoff),
  3. POSTs a local webhook on state transitions and restart outcomes,
  4. POSTs a heartbeat (with metrics) to the receiver.
- **Receiver** (Next.js on Vercel, self-hostable): ingests heartbeats, stores live state in
  Redis, runs a per-minute **sweep** that alerts when a node goes silent, and serves a single
  read-only status page.
- **Shared contract** (`@waydock/pulse-core`): zod schemas + TS types shared by both, so
  agent and receiver can never drift on payload shape.

### Out of scope (YAGNI — deliberately deferred)
- Dashboard with history/charts (v1 ships ONE status snapshot page).
- Postgres / long-term history (Redis is the hot layer; Postgres joins later, additively).
- Multi-tenant accounts, billing, per-customer API-key management.
- Arbitrary/custom user-defined metrics (v1 has a fixed built-in metric set).
- A service-installer generator (v1 ships launchd/systemd/pm2 **docs**, not a generator).
- Email/SMS/push alerting (v1 is webhook only: Discord + generic).

---

## 3. Architecture

```
   Mac mini / VPS (monitored box)                 Vercel (NEVER the same box)
 ┌──────────────────────────────────────┐       ┌───────────────────────────────────┐
 │  AGENT  (npx, long-running)           │       │  RECEIVER  (Next.js)              │
 │                                       │       │                                   │
 │  every 60s:                           │ POST  │  POST /api/heartbeat → Store      │
 │   1. check each agent (up/down)       │──────▶│  GET  /api/status   → JSON        │
 │   2. restart the dead ones            │       │  GET  /             → status page │
 │   3. local webhook on transitions ────┼──┐    │  GET  /api/cron/sweep             │
 │   4. heartbeat POST {agents, metrics} │  │    │    └─ every 60s (Vercel Cron):    │
 └──────────────────────────────────────┘  │    │       find overdue nodes,         │
                                            │    │       alert on silence/recovery   │
                                            ▼    │              │                    │
                                        Discord  │           Store (Redis/Upstash)   │
                                     (agent-level)│              │                    │
                                                 └──────────────┼────────────────────┘
                                                                ▼
                                                          Discord (host-level)
```

**Critical deployment rule:** the receiver MUST NOT run on a box it monitors (it would die
with it). It runs on Vercel. Docs will state this loudly.

**Why the receiver is serverless + cron (not a long-running container):** detecting *absence*
needs persistent state + a periodic check. Putting state in Redis (not local disk) decouples
state from compute, so the receiver can be plain Vercel functions + a cron-driven sweep. This
also makes the receiver survive redeploys with zero state loss.

---

## 4. Components

### 4.1 `@waydock/pulse-core` (shared)
- zod schemas + inferred TS types for: `Config`, `HeartbeatPayload`, `AgentStatus`, `Metrics`,
  `NodeRecord`.
- Pure, dependency-light. No I/O. The single source of truth for the wire contract.

### 4.2 `@waydock/pulse` (agent CLI)
Commands:
- `pulse init` — scaffold a `pulse.config.yaml`.
- `pulse start` — run the watch loop (the daemon).
- `pulse check` — run all checks once and print results. **Read-only:** never restarts, never
  POSTs (no webhook, no heartbeat) — safe for testing config.

Watch loop (every `interval`, default 60s):
1. **Check** each agent. Three unified check types — all are "run it, exit/return determines up":
   - `process: <name>` — pgrep-style convenience.
   - `http: <url>` — GET, 2xx = up.
   - `command: <cmd>` — escape hatch, exit 0 = up.
2. **Anti-flap:** an agent is declared `down` only after `confirm` consecutive failed checks
   (default 2). Prevents one transient miss from paging you.
3. **Restart:** on confirmed down, run the agent's `restart` command up to `retries` times with
   linear backoff (base 10s: attempt _n_ waits _n_×10s, re-checking after each). Record the
   outcome. If all `retries` are exhausted and still down, fire a single "restart failed" alert
   and leave the agent in `down` state; the next loop does not re-attempt until the agent recovers
   on its own or the next confirmed down→down→... cycle (no infinite restart storm).
4. **Local alert:** on a state transition (up→down, down→up) or restart outcome, POST to
   `webhook.url`. Discord-formatted if the URL is a Discord webhook, else generic JSON.
5. **Heartbeat:** collect metrics, POST `HeartbeatPayload` to `heartbeat.url` with the bearer
   token.

State: kept in memory while running; mirrored to `~/.pulse/state.json` so an agent restart does
not re-fire alerts for already-known states.

Cross-platform: macOS + Linux. Metrics via a small cross-platform source (e.g. `systeminformation`
or `os` built-ins). Running the agent itself as a service is documented (launchd / systemd / pm2),
not generated, in v1.

### 4.3 Receiver (Next.js on Vercel)
Routes:
- `POST /api/heartbeat` — `Authorization: Bearer <INGEST_TOKEN>`; zod-validate body;
  `Store.recordHeartbeat(payload)`. **Owns recovery alerts:** this route holds the fresh
  heartbeat, so if `recordHeartbeat` returns `{ recovered: true }` (the node was flagged
  `alerted` and is now reporting again), the route clears the flag and fires the recovery
  webhook ("🟢 `<node>` back"). The route therefore needs the notifier / `ALERT_WEBHOOK_URL`.
- `GET /api/status` — token-protected JSON: every node + computed liveness + latest metrics.
- `GET /` — ONE **server-rendered**, read-only status page (the dashboard seed): nodes,
  last-seen, CPU/mem, per-agent status dots. Reads via the Store server-side; the read token is
  used server-side and **never reaches the browser**. Gated by a simple shared password (env),
  since metrics may be sensitive.
- `GET /api/cron/sweep` — protected by Vercel's `CRON_SECRET`. **Owns "went silent" alerts only:**
  `Store.findOverdue(now − missThreshold)` returns overdue `NodeRecord`s (each carries its
  `alerted` flag); for each one **not already `alerted`**, fire the silence webhook
  ("🔴 `<node>` went silent") and `markAlerted(id, true)`. Already-alerted nodes are skipped, so a
  persistently dead node pages exactly once. (Recovery is fired by the ingest route above, not
  here — a recovered node is no longer overdue, so the sweep can't see it.)

`vercel.json` cron: `{ "path": "/api/cron/sweep", "schedule": "* * * * *" }`.

**Scheduler is load-bearing — flagged for self-hosters:** per-minute cron requires **Vercel Pro**.
On Vercel Free/Hobby, cron runs only once/day, which silently breaks the dead-man's-switch. So the
self-hosting docs MUST (a) state the Pro requirement, and (b) give a fallback for non-Pro
self-hosters: point an external 1-minute scheduler (**Upstash QStash**, or a plain `cron` /
systemd timer doing `curl …/api/cron/sweep` with the `CRON_SECRET`) at the same route. The sweep
route is a plain authenticated HTTP endpoint precisely so any scheduler works.

**Liveness rule:** `missThreshold` is a **receiver-side constant/env** (default 180s), independent
of any node's configured `interval` — the per-node interval is not sent over the wire, so the
receiver does not compute `3 × interval` per node; 180s is chosen to tolerate ~3 missed 60s beats.
A node is `down` when `now − lastSeen > missThreshold`. Sweep runs every 60s and computes "overdue"
purely from timestamps, so it is **idempotent and self-correcting** — a skipped tick is caught by
the next one, which is what makes the scheduler swappable.

---

## 5. Storage — the Store port (Redis now, Postgres-ready)

The receiver talks to a `Store` interface, never to Redis directly. This is the seam that lets
Redis stay the hot layer permanently once Postgres is added for history.

```ts
// NodeRecord is the receiver's per-node state (defined in @waydock/pulse-core).
// `alerted` is what lets the sweep page exactly once; `recordHeartbeat` reads the
// prior alerted state to decide whether this beat is a recovery.
type NodeRecord = {
  id: string            // = HeartbeatPayload.node
  lastSeen: number      // Unix SECONDS (= the heartbeat's ts)
  alerted: boolean      // true once a "went silent" alert has fired, until recovery
  agents: AgentStatus[] // latest per-agent status (display only)
  metrics: Metrics      // latest snapshot
}

interface Store {
  // Upserts the node, updates lastSeen/ZSET. Returns recovered:true iff the node
  // was previously `alerted` (i.e. this beat ends a silence) and clears the flag.
  recordHeartbeat(p: HeartbeatPayload): Promise<{ recovered: boolean }>
  getNode(id: string): Promise<NodeRecord | null>
  listNodes(): Promise<NodeRecord[]>
  findOverdue(cutoffTs: number): Promise<NodeRecord[]>  // lastSeen < cutoffTs; includes alerted flag
  markAlerted(id: string, alerted: boolean): Promise<void>
}
```

**v1 adapter — `RedisStore`** (Upstash REST via `@upstash/redis`, OR any `redis://` via ioredis,
so self-hosters aren't locked to Upstash):
- `node:<id>` → JSON snapshot matching `NodeRecord`: `{ id, lastSeen, alerted, agents, metrics }`.
- `nodes:lastseen` → ZSET scored by `lastSeen` → `findOverdue` = `ZRANGEBYSCORE … -inf <cutoff>`
  then `MGET` the snapshots (so each returned record carries its `alerted` flag).
- `node:<id>:samples` → capped LIST (`LPUSH` + `LTRIM`) of recent metric samples — optional in
  v1, enables a sparkline later.

**Growth path (NOT built in v1, but the interface guarantees it's additive):**
`PostgresStore` (cold/history) + `CompositeStore` (writes hot→Redis, cold→Postgres; reads live
state from Redis). The agent and the API routes never change.

---

## 6. Alerting responsibilities (no double-paging)

- **Agent → agent-level events** (via its local `webhook.url`): agent up↔down transitions and
  restart outcomes. Fast, on-box.
- **Receiver → host-level events** (via its `ALERT_WEBHOOK_URL`): "went silent" is fired by the
  **sweep** (once per silence, guarded by the `alerted` flag); "recovered" is fired by the
  **ingest route** when a flagged node heartbeats again (`recordHeartbeat` → `recovered: true`).

These are disjoint by construction. A fully dead box can't self-report → the receiver catches the
silence. A crashed agent on a live box is reported by the agent's local webhook. The agent-status
carried inside a heartbeat is used for the **status page display only**, NOT for receiver alerting
— that avoids double-paging on the same agent crash.

---

## 7. Security (v1)

- **Ingest auth:** a single shared bearer token (`INGEST_TOKEN`), same value in agent config and
  receiver env. Per-node API keys are a later (multi-tenant) concern.
- **Cron auth:** `/api/cron/sweep` requires Vercel's `CRON_SECRET`.
- **Status page:** gated by a simple shared password env. Read API requires a token.
- Secrets in config via `${ENV_VAR}` interpolation; never committed.

---

## 8. Configuration & contract

### Agent config — `pulse.config.yaml`
```yaml
node: mac-mini-newport                 # this box's identity (unique per box)
heartbeat:
  url: https://pulse.waydock.ai/api/heartbeat
  token: ${PULSE_INGEST_TOKEN}
  interval: 60                         # seconds
webhook:                               # local agent-level alerts (optional)
  url: https://discord.com/api/webhooks/...
agents:
  - name: openclaw
    check:   { process: openclaw }     # process | http | command
    restart: "launchctl kickstart -k gui/501/com.openclaw"
    retries: 3                         # restart attempts before giving up
    confirm: 2                         # consecutive failed checks before "down" (anti-flap)
metrics: { cpu: true, mem: true, disk: true }
```

### Heartbeat payload (the wire contract)
```json
{
  "node": "mac-mini-newport",
  "ts": 1733300000,
  "agents": [{ "name": "openclaw", "status": "up", "restarts": 0 }],
  "metrics": { "cpu": 12.3, "mem": 48.1, "disk": 62.0, "load1": 1.2, "uptime": 86400 }
}
```
`ts` is **Unix seconds** (pinned in the `@waydock/pulse-core` zod schema). The receiver stores it
verbatim as `NodeRecord.lastSeen` and all liveness math (`now − lastSeen > missThreshold`, the ZSET
score) is in seconds — agent and receiver must not drift to milliseconds.

v1 metrics = fixed built-in set: cpu/mem/disk %, load1, host uptime, plus per-agent status &
restart count.

### Receiver env
`PULSE_INGEST_TOKEN`, `CRON_SECRET`, `ALERT_WEBHOOK_URL`, `DASHBOARD_PASSWORD`,
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `REDIS_URL`).

---

## 9. Repo layout (monorepo, npm workspaces)

```
waydock-pulse/
  packages/
    core/        → @waydock/pulse-core  (zod schemas + types: the contract)
    agent/       → @waydock/pulse        (the npx CLI: watch, check, restart, webhook, heartbeat)
    receiver/    → Next.js app           (ingest API, sweep cron, status page, Store(Redis))
  docs/                                   (setup, launchd/systemd/pm2, self-hosting the receiver)
```

---

## 10. Testing

- **core:** zod schema unit tests (valid/invalid payloads, config parsing).
- **agent:** unit-test check runners (mock process/http/command), the anti-flap transition logic,
  restart retry/backoff, heartbeat payload building, Discord-vs-generic webhook formatting.
  Integration: run the loop against a fake receiver.
- **receiver:** an `InMemoryStore` for fast tests; unit-test sweep overdue logic, heartbeat
  validation + auth, notifier formatting. A thin contract test for `RedisStore` against Upstash.

---

## 11. Build order (for the implementation plan)

1. `core` — the contract (schemas + types).
2. `agent` — checks + anti-flap + restart + local webhook + heartbeat sender + `init`/`check`/`start`.
3. `receiver` — ingest API + `Store`/`RedisStore` + status page.
4. `receiver` — sweep cron + host-level alerting.
5. Deploy to `pulse.waydock.ai`, wire Upstash + Vercel Cron, and **dogfood on the real Mac mini**
   (retire the old bash watchdog).

---

## 12. Key decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Product model | Hybrid: OSS agent + self-hostable receiver, dashboard deferred | Lean now, grow later |
| Two failure classes | Local agent (agent-level) + off-box heartbeat (host-level) | A local watchdog can't report its own death |
| Receiver compute | Serverless (Vercel) + cron sweep | State in Redis decouples compute from state |
| Storage | Redis (Upstash) via a `Store` port | Right tool for hot/live state; Postgres added later, additively |
| Scheduler | Vercel Cron (Pro) | Leanest; sweep is idempotent so QStash is a drop-in later |
| Restart | In v1 (alert + restart) | The restart is the actual value, not just the alert |
| Hosting/brand | `pulse.waydock.ai`, code in its own public repo | Same audience as waydock; OSS agent must be public, waydock is private |
| Name | Pulse | "Is it pulsing?" — intuitive for technical and non-technical users |
```
