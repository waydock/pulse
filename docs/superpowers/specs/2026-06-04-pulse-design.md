# Pulse — Agent Uptime Monitor (v1 Design)

**Date:** 2026-06-04 · **Revised:** 2026-06-10 (Model C — receiver is a module inside waydock)
**Status:** Design — approved decisions, pending spec re-review
**Public repo:** `github.com/waydock/waydock-pulse` (the npm package only)
**Backend:** a module inside the private **waydock** app (Next.js on Vercel)
**Hosted at:** `waydock.ai/pulse` (v1) — brand subdomain `pulse.waydock.ai` is a later, reversible move
**npm:** `@waydock/pulse` (agent CLI), `@waydock/pulse-core` (shared contract)

---

## 1. Problem

People run AI agents (openclaw, Claude Code, Hermes, etc.) on always-on boxes — Mac
minis, cloud VPSes. Agents crash. The box itself can also die (power cut, network drop,
kernel panic, freeze). A purely local watchdog has a fatal blind spot: **it cannot report
its own death** — when the box goes, the watchdog goes silent with it.

Pulse solves both failure classes. It ships as a **paid feature of waydock**: the on-box
watcher is a public OSS npm package; the multi-tenant backend (accounts, isolation, alert
routing, dashboard) is a module inside the existing waydock product.

| Failure class | Example | Who can detect it |
|---|---|---|
| **Agent-level** | openclaw crashed, box is fine | The local **agent** (check + restart + alert) |
| **Host-level** | power out, network down, box frozen | The **receiver**, by noticing the heartbeat *stopped* |

The core insight: **host-level failure can only be caught off-box, as the absence of a
heartbeat. Silence is the alarm.**

---

## 2. Product shape & scope (v1)

**Two pieces, split along the only boundary that must be public:**

- **The agent** is public OSS (it runs on users' own boxes; `npx` demands it). It needs no
  login — it authenticates with an org-scoped **ingest key**.
- **The receiver** is a module **inside waydock** (private). It reuses waydock's auth, orgs,
  billing, webhooks, Redis, Postgres, and RLS isolation. This is the paid, multi-tenant value.

**What is actually sold (important framing):** check + **restart** + local alerting all run
*on-box in the OSS agent* — waydock has no control plane and structurally **cannot** gate them, so
**restart is free forever**. The paid product is the **receiver**: off-box silence detection,
the dashboard, history, team/RBAC, email alerting, faster detection, and more nodes. Pricing is
node-based (§13), not feature-based-on-restart.

### In scope
- **Agent** (`npx @waydock/pulse`): a long-running watcher that, every interval:
  1. checks each configured agent (up/down),
  2. restarts the dead ones (with retries/backoff) — unless that agent is set `alert-only`,
  3. POSTs a **local** webhook on state transitions and restart outcomes,
  4. POSTs a heartbeat (with metrics) to the receiver.
- **Receiver (inside waydock)**: ingests heartbeats into Redis via a `Store` port, runs a
  per-minute **sweep** cron that alerts when a node goes silent, and serves a **live status
  dashboard** at `/pulse` — multi-tenant, isolated per **Organization**, behind waydock's
  existing session + node-quota entitlement (§13).
- **Alerting** (host-level): per-org **webhook + email** (email via waydock's Resend).
- **CLI login** (`pulse login`): an OAuth 2.0 **Device Authorization Grant** (RFC 8628) so onboarding
  is one command + a browser approval (no manual key paste), and works over SSH/headless. **Additive**
  to manual keys, which stay for CI/automation. The flow ports chest-gate's proven implementation,
  swapping Privy→`iron-session` and agent-token→`pulse_ingest_keys`. See §4.4.
- **Shared contract** (`@waydock/pulse-core`): zod schemas + TS types. Published to npm and
  depended on by **both** the agent and the waydock receiver, so the wire shape can never drift.

### Out of scope (YAGNI — deliberately deferred)
- **A self-hostable / standalone receiver.** The contract is public, so a third party *could*
  build one — but we won't ship or maintain one. Pulse's backend is a commercial part of waydock.
- **Metered per-host overage billing.** v1 enforces a **hard cap at the plan's node allowance**
  (§13). The $2/host/mo metered add-on is a **fast-follow** (needs a Stripe metered price + usage
  reporting; waydock bills per-seat-quantity today, not metered).
- **Sub-minute *detection*.** Vercel cron floors at 1-minute granularity, so nothing is detected
  faster than ~60s in v1 (tiers still differ *above* 60s via heartbeat period — §13). Sub-60s
  detection is an additive fast-follow via an external trigger (QStash) or a Railway always-on
  worker — the idempotent sweep makes it drop-in.
- **Historical charts / long-term history.** v1 ships **live** monitoring + recent sparklines from
  a capped Redis samples list. Durable history is a later, additive `PostgresStore`.
- **Central control plane** that pushes check/restart **commands** to boxes. Box commands stay in
  the box-local `pulse.config.yaml` (a server→box command channel is a remote-code-exec surface —
  see §7). Note: server-*suggested* command templates the user copies are allowed (§4.2).
- Arbitrary/custom user-defined metrics (v1 has a fixed built-in metric set).
- SMS/push alerting (v1 host-level alerting is webhook + email only).
- A service-installer generator (v1 ships launchd/systemd/pm2 **docs**, not a generator).

---

## 3. Architecture

```
   Mac mini / VPS (monitored box)                 waydock app on Vercel (NEVER the same box)
 ┌──────────────────────────────────────┐       ┌────────────────────────────────────────────┐
 │  AGENT  (npx, long-running, OSS)      │       │  RECEIVER  (module inside waydock)          │
 │                                       │ POST  │  POST /api/pulse/heartbeat → Store          │
 │  every interval:                      │──────▶│   (Bearer = pulse ingest key → resolves Org)│
 │   1. check each agent (up/down)       │       │  GET  /pulse  → live dashboard (authed,     │
 │   2. restart the dead ones            │       │                 org-scoped, RBAC, RLS)      │
 │   3. local webhook on transitions ────┼──┐    │  GET  /api/pulse/cron/sweep  (CRON_SECRET)  │
 │   4. heartbeat POST {agents, metrics} │  │    │    └─ every 60s (waydock vercel.json cron): │
 └──────────────────────────────────────┘  │    │       find overdue nodes across all orgs,   │
                                            │    │       alert per-org (webhook + email)       │
                                            ▼    │              │                               │
                                        Discord  │   Store: Upstash Redis (hot live state)      │
                                     (agent-level)│         + Postgres (accounts now,           │
                                                 │           history later) + RLS isolation     │
                                                 └──────────────┼───────────────────────────────┘
                                                                ▼
                                       per-org webhook + email (host-level: "went silent")
```

**Critical deployment rule (unchanged):** the receiver MUST NOT run on a box it monitors. It
runs as part of waydock on Vercel — structurally off-box, so it survives any monitored box's death.

**Why this works inside waydock:** detecting *absence* needs persistent state + a periodic check.
waydock provides both — Upstash Redis (state) and Vercel Cron. **waydock is on Vercel Pro, which
supports per-minute (`* * * * *`) crons** (Hobby is daily-only), so the 60s sweep is fine.

**Detection-latency reality:** Vercel cron's finest cadence is **1 minute**, which is the **hard
floor** on detection speed — nothing is detected faster than ~60s in v1. Above that floor, the
per-node **heartbeat period** (§13) is a real tier lever (`detection ≈ period + grace + ≤1 sweep
tick`): at default grace 60s, free ≈ 6–7 min, pro ≈ 2–3 min, all achievable on plain Vercel Pro today. Only *sub-minute*
detection (below the 60s sweep) is a fast-follow: point **Upstash QStash** at the (idempotent,
plain-HTTP) sweep route every 20–30s, or run the sweep on **Railway** with an always-on internal
timer (no cron floor). No redesign — the sweep was built swappable for exactly this.

Heartbeat hot-state lives in Redis (not Postgres) because it's a high-frequency write path (every
box, every interval); Postgres holds accounts, the durable node registry (§5), and history later.

**Deployment topology (v1) — two Vercel projects, one shared DB/Redis (eng-review decision).** The public,
high-volume, session-less paths run in a **separate `pulse-ingest` Vercel project** to isolate blast radius
from the main waydock app: `POST /api/pulse/heartbeat`, the sweep cron, and the CLI-facing
`/api/pulse/oauth/device/code` + `/api/pulse/oauth/token`. The **session-bound** paths stay in the main
waydock app: the `/pulse` dashboard, `/pulse/device` page, `POST /api/pulse/device/authorize`, and
key-minting UI. Both import a **shared internal package** (`@waydock/pulse-server`: Prisma client + `db.ts`,
the `Store`/notifier, `lib/billing` entitlement helpers); both get `DATABASE_URL`, Upstash, `CRON_SECRET`,
Resend env. Trade-off accepted: a second deployment + shared-lib extraction, in exchange for ingest/sweep
load and faults never touching the core product. The per-minute cron lives in the ingest project (and is
where QStash/Railway swaps in later for sub-minute detection).
- **URL routing (outside-voice fix):** the two projects don't share a path namespace under one host. The
  ingest project gets its **own host** — `ingest.waydock.ai` (the agent's `heartbeat.url`); session surfaces
  stay on `waydock.ai/pulse`. No cross-project path rewrites.
- **Migration ownership (outside-voice fix):** the **main waydock app owns Prisma migrations**; `pulse-ingest`
  is a read/write consumer of the shared schema and **deploys after** migrations apply. Deploy ordering and
  generated-client version must match across both; rollback compatibility is a release-checklist item.

**Hot-path caching (eng-review decision).** Steady-state ingest must not hit Postgres per beat: the ingest
key → `{orgId, plan, nodeAllowance, allowedCidrs}` resolution is cached in Redis (~60s TTL), and the durable
`pulse_nodes` upsert is throttled to first-seen + status-change + a periodic (~5-min) `last_seen` refresh —
Redis stays the authoritative liveness source. **Cache invalidation is explicit (outside-voice fix):** key
revocation, CIDR changes, and plan downgrades **bust the cache entry immediately** (the 60s TTL is only a
backstop) — revocation is a security action, not "tolerated up to 60s".

---

## 4. Components

### 4.1 `@waydock/pulse-core` (shared, public npm)
- zod schemas + inferred TS types for: `Config`, `HeartbeatPayload`, `AgentStatus`, `Metrics`,
  `NodeRecord`.
- Pure, dependency-light, no I/O. The single source of truth for the wire contract.
- **Depended on by both** the agent and the waydock receiver (dependency flows public → private
  only; the public repo never imports waydock).

### 4.2 `@waydock/pulse` (agent CLI, public npm)
Commands:
- `pulse login` — OAuth 2.0 **Device Authorization Grant** (RFC 8628): prints a short code, opens
  the browser to `/pulse/device`, and on approval receives a freshly-minted org-scoped ingest key
  written to `~/.pulse/credentials.json`. No manual key paste; works over SSH/headless. See §4.4.
- `pulse init` — scaffold a `pulse.config.yaml`, offering **check+restart templates** (see below).
- `pulse start` — run the watch loop (the daemon).
- `pulse check` — run all checks once and print results. **Read-only:** never restarts, never
  POSTs (no webhook, no heartbeat) — safe for testing config.

Watch loop (every `interval`, default 60s):
1. **Check** each agent. An agent has **one or more checks; it is `up` iff *all* pass** (a real
   agent is often "process alive AND its HTTP port answers" — see the Hermes example below).
   Three unified check types — all "run it, exit/return determines up":
   - `process: <name>` — pgrep-style convenience.
   - `http: <url>` — GET, 2xx = up.
   - `command: <cmd>` — escape hatch, exit 0 = up.
2. **Anti-flap (explicit state machine):** an agent is `up`/`down`/`restarting`. A failed check
   increments a consecutive-fail counter; **any** passing check resets it to 0. The agent transitions
   `up → down` only when the counter reaches `confirm` (default 2). A passing check at any point —
   including between restart attempts — resets the counter and returns the agent to `up`. Fail counts
   accrued during a restart's backoff window belong to the *current* down cycle, not a new one.
3. **Restart:** on confirmed down, **unless the agent is `restart: false` (alert-only mode)**, run
   the agent's `restart` command up to `retries` times with linear backoff (base 10s: attempt _n_
   waits _n_×10s, re-checking after each). Record the outcome. If all `retries` are exhausted and
   still down, fire a single "restart failed" alert and leave the agent `down`; the next loop does
   not re-attempt until the agent recovers on its own (no infinite restart storm). An **alert-only**
   agent skips restart entirely and just transitions/alerts — for users who want monitoring without
   Pulse touching their processes.
   - **Multi-step recovery is the user's script, not a Pulse feature.** Because `restart` is an
     arbitrary shell command, complex escalation (e.g. "kickstart → if a token-lock conflict
     persists, sweep stale lockfiles → retry") is expressed by pointing `restart` at the user's
     own recovery script. v1 documents this escape hatch rather than generalizing escalation.
4. **Local alert:** on a state transition (up→down, down→up) or restart outcome, POST to
   `webhook.url`. Discord-formatted if the URL is a Discord webhook, else generic JSON.
5. **Heartbeat:** collect metrics, POST `HeartbeatPayload` (incl. this node's `interval`) to
   `heartbeat.url` with the ingest key. **The heartbeat runs on its OWN independent timer**, never
   blocked by check/restart work (outside-voice fix): a slow or looping restart must not delay the
   beat, or a single broken local process would make the whole host look DEAD to the receiver
   (agent-failure misread as host-failure → false host-down page). Check/restart and heartbeat are
   concurrent loops sharing only the in-memory state snapshot.

**Check + restart templates (the "node templates" request — kept safe).** Onboarding non-experts
needs ready-made recipes for common stacks (launchd, pm2, systemd, docker, http). Two surfaces,
both of which keep the **no-control-plane** guarantee:
- **(a) Local CLI templates** — `pulse init` detects/offers recipes and scaffolds the right
  check+restart into the *local* YAML. Commands live only on the box.
- **(b) Portal-suggested templates** — `/pulse` *displays* a library of recommended commands the
  user **copies** into their local config. The box never auto-fetches commands from the server.

State: kept in memory while running; mirrored to `~/.pulse/state.json` so an agent restart does
not re-fire alerts for already-known states. The mirror is written **atomically** (temp file +
rename); an unreadable/corrupt/partial state file is treated as empty (start fresh) rather than crashing.

Cross-platform: macOS + Linux. Metrics via a small cross-platform source (e.g. `systeminformation`
or `os` built-ins). Running the agent itself as a service is documented (launchd / systemd / pm2),
not generated, in v1. **launchd restart form** (validated against the user's real watchdog):
`launchctl kickstart -k gui/$(id -u)/<label>`.

### 4.3 Receiver (two deployments — see §3 topology)
Session-bound code lives in the main waydock app (`src/app/pulse/*` dashboard + `/pulse/device`,
`src/app/api/pulse/device/authorize`); session-less high-volume code lives in the separate
`pulse-ingest` project (`heartbeat`, `cron/sweep`, `oauth/device/code`, `oauth/token`). Both import the
shared `@waydock/pulse-server` package (`Store`, notifier, gate, settings). Routes:

- `POST /api/pulse/heartbeat` *(ingest project)* — `Authorization: Bearer <pulse ingest key>`. Resolve the
  key via the **Redis-cached** key-hash → `{orgId, plan, nodeAllowance, allowedCidrs}` map (~60s TTL; §3),
  falling back to `pulse_ingest_keys` on miss; CIDR check; rate-limited via `@upstash/ratelimit`. zod-validate
  body. **Clamp** the agent-reported `interval` to `[plan period floor, 3600s]` before deriving the deadline
  (the wire value is user-controlled — prevents tier-bypass and never-silent defeat). **Node-quota check**
  (§13): a *new* node beyond `nodeAllowance` is rejected `402`; existing nodes always ingest.
  `Store.recordHeartbeat(orgId, payload)` — **registry-upsert-first then atomic Redis hot write** (§5); a Redis
  failure returns `5xx` so the agent retries next beat. **Owns recovery alerts:** if `recordHeartbeat` returns
  `{ recovered: true }` it clears the flag and fires the org's recovery alert ("🟢 `<node>` back", webhook + email).
- `GET /pulse` *(main app)* — the **live dashboard**, server-rendered, behind `requireSession()`, scoped to the
  session's **active Organization** (RLS-isolated). Reads the durable **`pulse_nodes` registry LEFT JOIN the
  Redis hot state** — so a node present in the registry but with an expired/missing snapshot renders **DOWN**
  (a long-dead box stays visible, never vanishes). **RBAC:** owners/admins manage settings, keys, and alert
  channels; members **view** non-private nodes/alerts (admin/owner-marked **private** nodes are hidden from
  members). Shows nodes, last-seen, CPU/mem/disk, per-agent status dots, recent sparklines.
- `GET /api/pulse/status` — JSON; session-scoped to the active org (same RBAC + RLS).
- `GET /api/pulse/cron/sweep` *(ingest project)* — protected by `CRON_SECRET`. **Owns "went silent" alerts
  only:** `Store.findOverdue(now)` returns nodes whose **deadline is strictly in the past** across
  **all orgs** (each carries `organization_id` + `alerted`); for each **not already `alerted`**,
  fire that org's silence alert ("🔴 `<node>` went silent", webhook + email), respecting the org's
  **alert cooldown** (§13). **Durable delivery via an alert outbox (outside-voice fix), not a boolean:** for
  each new silence the sweep first **persists a `pulse_alerts` outbox row** (`pending`) — this, not a flag,
  is what makes the alert exactly-once and recoverable — then a dispatch path drives per-channel state
  (`pending → dispatching → delivered | failed`, retry, **dead-letter** after N) for webhook + email; the
  node's `alerted` flag is derived from "an open outbox episode exists" so a dispatch-ok/mark-fail can't
  double-page and a mark-ok/channel-fail can't silently miss. **Bounded** — a per-tick cap + bounded
  concurrency within a time budget; overflow drains on the next (idempotent) tick and is **logged, never
  silently dropped** — so a mass-silence event can't blow the function timeout. (Recovery is fired by the
  ingest route and closes the outbox episode.) **No lapse filter:** downgrade-paused nodes are `ZREM`'d, so
  `findOverdue` can't see them. The outbox doubles as the **incident history** the product wants later.

- **CLI login (device grant, RFC 8628)** — three routes (see §4.4 for the flow):
  - `POST /api/pulse/oauth/device/code` (no auth) — issue `device_code` + `user_code`.
  - `POST /api/pulse/device/authorize` (waydock session) — browser confirms the `user_code`; **mints
    a `pulse_ingest_keys` row scoped to the active org** (RBAC owner/admin + entitlement enforced here).
  - `POST /api/pulse/oauth/token` (no auth) — CLI polls; returns the key, or `authorization_pending` /
    `slow_down` / `access_denied` / `expired_token` / `invalid_grant` (unknown/used code) /
    `unsupported_grant_type` (per RFC 8628).
  - `GET /pulse/device` (page) — session-gated code-entry/confirm page, with an **org picker** when the
    user belongs to more than one org.

Add the cron to the **`pulse-ingest` project's** `vercel.json` (not the main app's — outside-voice fix):
`{ "path": "/api/pulse/cron/sweep", "schedule": "* * * * *" }`. **Sweep self-monitoring (outside-voice fix —
who watches the watchman):** the sweep records a `last_swept_at` timestamp each run, and an **external
synthetic check** (independent of Vercel cron) pages the team if `last_swept_at` goes stale — a silently
dead cron must not silently kill detection.

**Liveness rule (per-node deadline).** Each node has an **expected period** (the agent's `interval`,
sent in the heartbeat) + a **grace** (per-org/per-node setting, §13). A node is `down` when
`now > lastSeen + period + grace`. The receiver stores this **deadline** as the node's ZSET score
(§5), so the sweep finds all overdue nodes in one query regardless of differing per-node periods.
**Grace floor = the sweep tick (60s)** so a healthy-but-slightly-late beat isn't false-alarmed
between ticks; **default grace 60s**, raise it (per-org/per-node) to tolerate missed beats at the
cost of slower detection. The sweep is **idempotent and self-correcting** — a skipped tick is caught
by the next.

**Entitlement / quota gate.** Pulse is quota-based per-org, not a binary flag (every plan gets a free
node — §13). waydock's seat helpers (`hasEntitlement`/`requirePaidSeat`) are **user-keyed** and can't
run on the user-less ingest path, so ingest uses the **org-level** `getOrgPlan(organizationId)`
(entitlements.ts) to read the plan's node allowance. Seat helpers still gate *interactive* surfaces
(key minting, settings). (During the billing-flag-off rollout window `getOrgPlan` short-circuits to
`'pro'`, so allowance is effectively Pro until billing is enabled — matching existing waydock behavior.)
**Lapse handling is grace-based — see §13.**

### 4.4 CLI login — Device Authorization Grant (RFC 8628)

Ports chest-gate's proven device-grant flow, swapping its primitives for waydock's (Privy →
`iron-session`; wallet-scoped agent token → **org-scoped `pulse_ingest_keys`**). New table
`pulse_device_codes` (same shape as chest-gate's: `deviceCodeHash`, `userCodeHash`, `hostname`,
`status` pending→**authorizing**→authorized→consumed / denied / expired, `organizationId` +
`ingestKeyId` set on authorize, the minted key held **encrypted-at-rest** (`encryptedKey`, not plaintext —
outside-voice fix) only between authorize and the next poll and **cleared on consume**, `lastPolledAt`,
`expiresAt`). The `authorizing` claim state (atomic claim-before-mint, as in chest-gate) prevents a
double-approval from minting two keys.

Flow:
1. `pulse login` → `POST /api/pulse/oauth/device/code` `{ client_id: "pulse-cli", hostname }` →
   `{ device_code, user_code, verification_uri: ".../pulse/device", verification_uri_complete,
   expires_in: 900, interval: 5 }`. CLI prints `user_code` and opens the browser.
2. User (already signed into waydock) lands on `GET /pulse/device`, which **`requireSession()`**s.
   They confirm the `user_code`; if they belong to multiple orgs, an **org picker** chooses the scope.
3. `POST /api/pulse/device/authorize` (session-authed) checks **RBAC (owner/admin)** + **Pulse
   entitlement** for the chosen org, atomically **claims** the row (`pending`→`authorizing`) so a
   duplicate approval can't double-mint, mints a `pulse_ingest_keys` row scoped to the org, and flips
   to `authorized` (stashing the plaintext key for the pending poll).
4. CLI polls `POST /api/pulse/oauth/token` (`grant_type=…:device_code`) honoring `interval`/`slow_down`;
   on success receives the key and writes it to `~/.pulse/credentials.json` (one-shot consume).

Security shape (lifted from chest-gate): `device_code` = 32-byte base64url, `user_code` = 8 chars from
an ambiguity-free alphabet — **both stored only as sha256**; 900s TTL; `slow_down` on too-fast polls;
one-shot consume; expired/denied rows swept. Manual key-paste remains for CI (no browser).

---

## 5. Storage — the Store port (Postgres registry + Redis hot)

The receiver talks to **one** tenant-aware `Store` seam that internally composes **two** backends
(eng-review decision): a durable **Postgres `pulse_nodes` registry** (a node exists here from first
heartbeat / device-grant until explicit delete — survives Redis eviction, anchors quota + future history)
and the **Redis hot layer** (live snapshot + deadline ZSET + samples). A node never disappears because a
Redis TTL lapsed — TTL governs only whether the *live snapshot* is fresh, never whether the node *exists*.

```ts
// NodeRecord = durable registry fields ⊕ Redis hot fields, joined behind the Store seam.
type NodeRecord = {
  // ── durable (Postgres pulse_nodes; survives Redis loss) ──
  organizationId: string  // tenant — never sent by the agent; derived from the ingest key
  id: string              // = HeartbeatPayload.node (unique *within* an org)
  firstSeen: number       // registry row creation (Unix seconds)
  paused: boolean         // true when paused by a billing downgrade (§13): retained, ZREM'd, no alerts
  visibility: 'org' | 'private'  // 'private' = hidden from non-admin members
  // ── hot (Redis; null/stale ⇒ render DOWN) ──
  lastSeen: number | null // Unix SECONDS = receiver ARRIVAL time of last beat (NOT agent ts); null until first beat
  clientTs: number | null // agent-reported ts — display metadata only, never used for liveness
  expectedPeriod: number  // seconds; = the agent's reported interval (clamped to plan floor, §4.3)
  deadline: number        // = lastSeen + expectedPeriod + grace (the ZSET score)
  alerted: boolean        // true once a "went silent" alert has fired, until recovery
  agents: AgentStatus[]   // latest per-agent status (display only)
  metrics: Metrics | null // latest snapshot; null when no fresh hot state
}

interface Store {
  recordHeartbeat(orgId: string, p: HeartbeatPayload): Promise<{ recovered: boolean }>
  getNode(orgId: string, id: string): Promise<NodeRecord | null>
  listNodes(orgId: string): Promise<NodeRecord[]>          // dashboard: registry LEFT JOIN hot, this org
  countNodes(orgId: string): Promise<number>               // quota — counts durable registry rows
  findOverdue(nowTs: number): Promise<NodeRecord[]>         // sweep: ACROSS all orgs, deadline < now (Redis)
  markAlerted(orgId: string, id: string, alerted: boolean): Promise<void>
  deleteNode(orgId: string, id: string): Promise<void>     // removes registry row + Redis keys + ZSET member
}
```

**Redis hot keys** (reuses waydock's existing Upstash instance; keys namespaced by org):
- `pulse:t:<org>:node:<id>` → JSON of the hot fields. **Long TTL governs freshness only** — its expiry
  does NOT delete the node (the registry row persists); an absent snapshot just means "render DOWN".
- `pulse:deadlines` → **one global** ZSET (v1), member = `"<org>:<id>"`, **score = `deadline`**. So
  `findOverdue(now)` is a single `ZRANGEBYSCORE … -inf (<now>` + `MGET`, then group by org for per-tenant
  alert routing — O(1)-ish, no per-org fan-out, per-node periods resolve naturally. **Scale lever
  (documented, not built):** if this single key becomes a write hotspot at very high node counts, shard
  into N ZSETs by `hash(org+id)` and fan the sweep across shards. Don't build until needed.
- `pulse:t:<org>:node:<id>:samples` → capped LIST (`LPUSH` + `LTRIM`) → powers v1 sparklines.
- **Caches (§3):** `pulse:key:<hash>` → `{orgId,plan,nodeAllowance,allowedCidrs}` (~60s TTL) so steady-state
  ingest auth+entitlement is Redis-only.

**Write order + atomicity:** `recordHeartbeat` is **registry-first, then Redis**: (1) upsert the durable
`pulse_nodes` row (idempotent; throttled — first-seen + status-change + ~5-min `last_seen` refresh, §3),
(2) the **atomic Redis hot write** (single Lua/pipeline: snapshot + `ZADD pulse:deadlines` with the new
deadline). A Redis failure after step 1 returns `5xx` so the agent retries next beat (the node already
exists in the registry, rendering DOWN until a hot snapshot lands). The `alerted` transitions —
`recordHeartbeat`'s *read-prior-`alerted` → clear* and the sweep's *read → set* — are **atomic (Lua
compare-and-set)** so a heartbeat landing the same instant as a sweep tick can't both fire silence and
clear it (this is what makes §6's "disjoint by construction" true).

**Reconciliation sweep (outside-voice fix — Redis is NOT solely trusted).** The per-minute sweep reads the
Redis ZSET; a **periodic (~5-min) reconciliation pass** additionally scans the durable `pulse_nodes`
registry and re-derives liveness for any non-paused node **missing from the ZSET** (Redis evicted/lost its
deadline) — if its (throttled) `last_seen + period + grace < now`, it's re-added to the ZSET and treated as
overdue. This closes the core-value gap where a lost Redis member would otherwise silently un-monitor a dead
host. Cheap because throttled (not every tick).

**Node lifecycle:** a node leaves **only** via explicit `deleteNode(orgId, id)` (removes the registry row,
Redis snapshot, samples, ZSET member) exposed in `/pulse`. A long-dead box therefore stays in the registry
and renders **DOWN** indefinitely — it never silently vanishes. **Paused** (billing downgrade, §13) is
distinct from deleted: the registry row is **retained** with `paused: true`, its `pulse:deadlines` member
is **`ZREM`'d** (so the sweep can't see it, no alerts). A paused node's next heartbeat re-adds the deadline
(un-pausing) **iff** the org is back within allowance; otherwise that beat is the over-allowance `402` (§4.3).
"Most-recently-active" (the node a downgrade keeps) = the node with the **max `lastSeen`** read from the
**authoritative Redis hot state**, not the throttled Postgres `last_seen` (outside-voice fix — the throttle
could otherwise pause the wrong node). **Registry reaping (outside-voice fix):** node id is user-chosen text,
so renames/reinstalls/clones create new rows; a registry row **never re-seen for N days** (default 30) is
auto-reaped so churn doesn't burn quota forever (documented: a rename = a new node).

**Tenant isolation (stated honestly):** for **Postgres**, per-org reads run under RLS
(`runInOrgContext`); the cross-org **sweep** is a sanctioned **BYPASSRLS** path (`basePrisma`,
`reason: 'cron-sweep'`), so its isolation is *code-level org grouping*, not RLS. For **Redis** there
is **no RLS** — hot-path isolation is the `pulse:t:<org>:` key-namespacing convention, enforced by
application code. Two orgs may both have a node named `mac-mini` with zero collision.

**Growth path (additive, interface-guaranteed):** `PostgresStore` (history) + `CompositeStore`
(writes hot→Redis, cold→Postgres; reads live from Redis). Agent and API routes don't change.

---

## 6. Alerting responsibilities (no double-paging)

- **Agent → agent-level events** (via its local `webhook.url`): agent up↔down transitions and
  restart outcomes. Fast, on-box.
- **Receiver → host-level events** (via the **org's** webhook **and email**): "went silent" is fired
  by the **sweep** (once per silence, guarded by `alerted`, subject to the org cooldown); "recovered"
  is fired by the **ingest route** when a flagged node heartbeats again.

Disjoint by construction. A fully dead box can't self-report → the receiver catches the silence.
A crashed agent on a live box is reported by the agent's local webhook. Agent-status inside a
heartbeat is for **dashboard display only**, never for receiver alerting — that avoids double-paging.

**Channels:** per-org **webhook** (Discord/generic) + **email** (waydock's Resend). Email recipients
default to org owners/admins; configurable. **Cooldown is scoped per-node-per-event-type** (outside-voice
fix): it throttles repeat *silence* alerts for the *same* node only — it **never** suppresses a recovery
alert, nor a *different* node's alert in the same org. (Silence already pages once via the outbox episode;
cooldown is the anti-flap backstop for a node that recovers and re-fails rapidly.)

**Per-org alert routing uses a dedicated `pulse_alert_webhooks` table** (org-scoped, `organization_id`
NOT NULL, encrypted secret, delivery status), with its own resolver. We do **not** reuse waydock's
`outbound_alert_webhooks`: that table is **user-scoped** (`user_id` NOT NULL) and MCP-shaped — its
dispatch keys on `userId` and matches on MCP dimensions (`provider`/`is_mutation`/`operation_prefixes`),
none of which map to Pulse host events. We follow its proven *pattern* — secret encryption, signed
delivery, last-status/fire-count tracking — not the table.

---

## 7. Security (v1)

- **Ingest auth:** org-scoped **ingest keys** in a new `pulse_ingest_keys` table — a **parallel**
  table mirroring `mcp_api_keys` (hashed `key_hash`, scopes, revoke/rotate/expiry, `allowed_cidrs`,
  audit log), reusing its sha256 + timing-safe + CIDR resolution (`src/lib/mcp-auth.ts`). Unlike the
  parent table, **`organization_id` is NOT NULL**. Multiple keys per org supported; **one-per-box
  recommended** (so a single box can be revoked) but a key **may serve multiple nodes**.
- **CLI login (device grant):** `pulse_device_codes` stores only **sha256** of `device_code` /
  `user_code`; 900s TTL; `slow_down` polling; one-shot consume. The browser authorize step runs under
  the waydock session, so **RBAC (owner/admin) + Pulse entitlement** gate key minting (§4.4).
- **Tenant isolation:** per-org Postgres reads run under **RLS** (`runInOrgContext`, `waydock_app`
  role); the cross-org **sweep** is a sanctioned **BYPASSRLS** path (`basePrisma`, `reason:'cron-sweep'`)
  whose isolation is code-level org grouping, not RLS. Redis has no RLS — hot-path isolation is the
  `pulse:t:<org>:` key namespace (application-enforced). See §5.
- **RBAC:** owner/admin manage keys, settings, alert channels, and node visibility; members view
  non-private nodes/alerts only.
- **Cron auth:** `/api/pulse/cron/sweep` requires `CRON_SECRET` (same mechanism as waydock's crons).
- **Dashboard:** waydock session (`requireSession`) + active-org scoping + RBAC. No shared password.
- **Rate limiting:** ingest path uses the existing `@upstash/ratelimit`.
- **Untrusted wire input:** the agent-reported `interval` is clamped server-side to `[plan period floor,
  3600s]` before deriving the deadline (§4.3) — a user-controlled value can't bypass the tier floor or push
  the deadline out far enough to defeat silence detection.
- **Blast-radius isolation:** the public high-volume ingest + sweep run in a separate `pulse-ingest` Vercel
  project (§3), so an ingest flood/bug can't degrade the core waydock app's function pool.
- **No server→box command channel:** box restart/check commands live only in the local
  `pulse.config.yaml`, so a compromised backend cannot execute shell on monitored boxes.
  Portal command *templates* are display-only and copied by the user (§4.2) — boxes never auto-pull.
- Secrets in the agent config via `${ENV_VAR}` interpolation; never committed.

---

## 8. Configuration & contract

### Agent config — `pulse.config.yaml` (box-local; the management surface for box commands)
```yaml
node: mac-mini-newport                 # this box's identity (unique within your org)
heartbeat:
  url: https://ingest.waydock.ai/api/pulse/heartbeat   # ingest project's own host (§3)
  key: ${PULSE_INGEST_KEY}             # optional: explicit key for CI. Normally `pulse login` writes
                                       # the minted key to ~/.pulse/credentials.json (preferred over inline)
  interval: 60                         # seconds — sent in the heartbeat; receiver CLAMPS to [plan floor,3600] then derives the deadline
webhook:                               # local agent-level alerts (optional)
  url: ${PULSE_DISCORD_WEBHOOK}
defaults:                              # per-agent OVERRIDE base (override #1, see below)
  retries: 3
  confirm: 2
agents:
  - name: hermes                       # one logical agent…
    group: hermes                      # optional display grouping on the dashboard
    checks:                            # …with MULTIPLE checks — up iff ALL pass
      - { process: ai.hermes.gateway }
      - { http: http://127.0.0.1:9119/ }
    restart: "launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway"
    retries: 5                         # overrides defaults.retries for this agent
  - name: openclaw
    checks: [{ process: openclaw }]
    restart: false                     # alert-only: monitor + alert, never auto-restart
metrics: { cpu: true, mem: true, disk: true }
```

**Config overrides — the two that exist in v1 (and the one that doesn't):**
1. **Per-agent local defaults** — a box-level `defaults` block (retries/confirm/interval) an
   individual agent overrides. Local to one box's YAML. *In v1.*
2. **(deferred)** Per-host central overrides pushed from a server — the control plane we are NOT
   building (§7). Not in v1.
3. **Per-org receiver settings** — org-level knobs stored server-side, edited in `/pulse` (§13):
   alert webhook + email recipients, grace/detection floor, alert cooldown, node visibility. *In v1.*

### Heartbeat payload (the wire contract)
```json
{
  "node": "mac-mini-newport",
  "ts": 1733300000,
  "interval": 60,
  "agents": [{ "name": "hermes", "status": "up", "restarts": 0 }],
  "metrics": { "cpu": 12.3, "mem": 48.1, "disk": 62.0, "load1": 1.2, "uptime": 86400 }
}
```
`ts` and `interval` are **Unix seconds** (pinned in the `@waydock/pulse-core` zod schema).
**Liveness uses the receiver's ARRIVAL TIME, not the agent's `ts`** (outside-voice fix): `lastSeen =
server now` and `deadline = arrivalTime + clamped(interval) + grace`. The agent's `ts` is kept only as
**display metadata** (e.g. show client/server clock drift) — never trusted for detection, so clock skew
or a malicious future `ts` can't push the deadline out and defeat silence detection. The payload carries
**no org id** — the org is derived server-side from the ingest key, so a key can't write another tenant's data.

v1 metrics = fixed built-in set: cpu/mem/disk %, load1, host uptime, plus per-agent status &
restart count.

### Receiver config (mostly inherited from waydock)
Reuses `SESSION_SECRET`, `DATABASE_URL`, `UPSTASH_REDIS_REST_URL/TOKEN`, `CRON_SECRET`, Stripe +
Resend — all already set. New surface: the `pulse_nodes`, `pulse_ingest_keys`, `pulse_alert_webhooks`,
`pulse_alerts` (outbox), `pulse_device_codes` tables + per-org `pulse_settings`, Pulse node-allowance
quotas in `PLANS`, and a key for encrypting the held device-grant key at rest.

---

## 9. Repo layout

**Public — `waydock-pulse` (the npm package only):**
```
waydock-pulse/
  packages/
    core/   → @waydock/pulse-core   (zod schemas + types: the contract)
    agent/  → @waydock/pulse         (the npx CLI: watch, check, restart, webhook, heartbeat, templates)
  docs/                              (setup, launchd/systemd/pm2, config reference)
```

**Private — the receiver, split across two Vercel deployments + a shared package (§3):**
```
waydock/  (main app — session-bound surfaces)
  src/app/pulse/…            (dashboard + /pulse/device page — requireSession, RBAC, org-scoped)
  src/app/api/pulse/device/authorize/…  (browser confirm — session, RBAC, entitlement, claim→mint)
  src/app/api/pulse/keys/…   (ingest-key minting/revoke/rotate UI API — session, owner/admin)
  src/lib/billing/plans.ts   (+ Pulse node-allowance quotas)

pulse-ingest/  (separate Vercel project — session-less, high-volume)
  app/api/pulse/heartbeat/…  (ingest: cached key resolve, clamp, quota, dual-store write)
  app/api/pulse/cron/sweep/… (silence detection + bounded alert dispatch)
  app/api/pulse/oauth/…      (device/code, token — CLI-facing, no session)
  vercel.json                (the per-minute sweep cron lives here)

packages/pulse-server/  (shared internal pkg, imported by BOTH deployments)
  → @waydock/pulse-server   (Prisma client + db.ts, Store [Postgres registry ⊕ Redis hot],
                              notifier [webhook+email], entitlement gate, device-grant codec)

prisma/  (shared schema, MAIN APP OWNS MIGRATIONS) → pulse_nodes (durable registry), pulse_ingest_keys,
                             pulse_alert_webhooks, pulse_alerts (delivery outbox / incident history),
                             pulse_device_codes, per-org pulse_settings
```
Both deployments depend on the published `@waydock/pulse-core` (wire contract) and the internal
`@waydock/pulse-server` (server logic). Dependency flows public → private only.

---

## 10. Testing

- **core:** zod schema unit tests (valid/invalid payloads incl. `interval`, config parsing,
  multi-check & group, `restart: false`).
- **agent:** unit-test check runners (mock process/http/command), all-checks-must-pass logic, the
  anti-flap transition state machine, restart retry/backoff, alert-only skip, heartbeat payload
  building, Discord-vs-generic webhook formatting, atomic state-file write. Integration: run the loop
  against a fake receiver.
- **receiver:** an `InMemoryStore` for fast tests; unit-test deadline/overdue logic (per-node periods +
  cross-org grouping), heartbeat validation + cached key resolution + CIDR + node-quota gate, per-org alert
  routing (webhook + email) + cooldown, lapse/downgrade behavior, RBAC + private-node visibility, RLS
  isolation, and the **device-grant** flow (code issue, authorize w/ RBAC/entitlement + org scoping +
  claim-prevents-double-mint, poll/`slow_down`/`invalid_grant`/consume — reusing chest-gate's test patterns).
  A thin contract test for `RedisStore` against Upstash.
- **eng-review-mandated unit tests (Issues 1-7, non-negotiable):** `interval` clamp to `[floor,3600]`;
  `recordHeartbeat` registry-first → atomic Redis, **Redis-fail → 5xx**, no divergence; durable registry —
  **dead/expired-snapshot node renders DOWN** via registry LEFT JOIN hot, `deleteNode` removes everything,
  paused node `ZREM`'d + un-pause-on-rebeat; recovery-vs-silence **Lua compare-and-set** (same-tick race);
  sweep **bounded dispatch + per-tick cap + log-when-capped**; quota — over-allowance new node `402` while
  existing nodes keep ingesting, paused-node rebeat `402`; hot-path cache hit/miss + ~60s staleness.
- **outside-voice-mandated tests (non-negotiable):** liveness uses **receiver arrival time**, not agent `ts`
  (future/skewed `ts` can't defeat detection); **heartbeat keeps flowing during a long restart** (agent loop
  decoupled — broken process ≠ host-down); **reconciliation** re-detects a node whose Redis ZSET member was
  lost; **alert outbox** delivery state machine (dispatch-ok/mark-fail → no dup; mark-ok/channel-fail → no
  miss; dead-letter after N); **cache-bust on key-revoke/plan-change** (no post-revoke ingest); **registry
  reaping** of nodes unseen N days; **downgrade pauses the max-Redis-lastSeen node**; cooldown never
  suppresses recovery or another node; **sweep-staleness** synthetic fires when `last_swept_at` goes stale.
- **E2E (3 flows, eng-review decision):** (1) **box dies → silence detected → webhook+email fires** (the
  core value, agent→ingest→sweep→notifier); (2) **subscription lapse → grace still-monitored → cancel →
  downgrade pauses excess → re-subscribe resumes**; (3) **`pulse login` full device-grant** (CLI + browser +
  DB). Recovery-alert and member-can't-see-private-node stay integration/unit.
- **Capability-parity check (dogfood gate):** the new system must match the retired bash watchdog —
  launchd `kickstart` recovery and state-change-only alerts — before the old watchdog is removed.

---

## 11. Build order (for the implementation plan)

1. `core` — the contract (schemas + types incl. `interval`), published to npm.
2. `pulse-server` — extract the shared internal package: Prisma client/`db.ts`, the `Store`
   (**Postgres `pulse_nodes` registry ⊕ Redis hot**), notifier (webhook+email), entitlement gate,
   device-grant codec. Both deployments import this.
3. `agent` — checks (multi-check) + anti-flap + restart (+ alert-only) + local webhook + heartbeat
   sender + `init`/`check`/`start` + `login` (device grant) + check/restart templates.
4. `pulse-ingest` project — `pulse_nodes` + `pulse_ingest_keys` migrations; ingest API (**cached** key
   resolution + CIDR + rate-limit + **interval clamp** + node-quota gate + **registry-first → atomic Redis**
   dual-store write); deadline ZSET + RLS.
5. `pulse-ingest` project — sweep cron (deadline overdue + recovery-vs-silence Lua CAS + **bounded dispatch**
   + **`pulse_alerts` outbox delivery state machine** [pending→dispatching→delivered/failed, retry, dead-letter]
   + **periodic registry↔Redis reconciliation** + **sweep self-monitoring** [`last_swept_at` + external
   synthetic]) + per-org alerting (webhook + email) + scoped cooldown; the CLI-facing `oauth/device/code` +
   `oauth/token`. Per-minute sweep in this project's `vercel.json`; ingest on its own host `ingest.waydock.ai`.
6. **★ EARLY DOGFOOD GATE (outside-voice fix)** — with the agent + ingest + sweep + a *manually-pasted* key +
   webhook alert, **prove the core alarm on the real Mac mini**: kill a process / pull the network, confirm
   silence is detected and delivered, and clear the **capability-parity** bar vs the bash watchdog. Do this
   BEFORE building the commercial layer. If the core insight is flawed, it surfaces here — cheaply.
7. main app — device-grant `authorize` + `/pulse/device` page w/ org picker (`pulse_device_codes`, key
   encrypted-at-rest; ports chest-gate) + `/pulse` dashboard (registry LEFT JOIN hot, dead=DOWN, org-scoped,
   RBAC, private nodes) + key minting/revoke UI (cache-bust on revoke) + per-org settings (grace, cooldown,
   alert channels) + portal template library.
8. Billing — Pulse node-allowance quotas in `PLANS` (free 1 / pro 10), hard cap, lapse grace + downgrade-pause
   (reads Redis lastSeen) + dunning comms (§13); registry reaping job.
9. **Final dogfood + open to all** (retire the old bash watchdog; no existing Pulse users → no migration).
   Migrations owned by the main app; deploy ordering = migrate → main app → pulse-ingest.

---

## 12. Key decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Product model | Paid waydock feature: public OSS **agent** + receiver **inside waydock** | Reuses waydock's whole multi-tenant stack; agent must be public |
| What's sold | **Restart is free** (local, ungatable); the **receiver** is the paid product | No control plane = server can't gate on-box behavior |
| Two failure classes | Local agent (agent-level) + off-box heartbeat (host-level) | A local watchdog can't report its own death |
| Receiver home | waydock app (session surfaces) + a **separate `pulse-ingest` Vercel project** (ingest/sweep/oauth), shared via `@waydock/pulse-server` | Reuses waydock's stack; isolates public high-volume ingest blast radius (eng-review) |
| Tenancy | Tenant = waydock **Organization**; RLS (Postgres) + key-namespace (Redis) | Already built and audited |
| Auth | Reuse waydock `iron-session`; RBAC owner/admin vs member; private nodes | One identity; Pulse is a plan feature |
| Ingest keys | New `pulse_ingest_keys` table, parallel to `mcp_api_keys`; multi-key/org, 1-per-box rec. | Same hardened pattern, separate semantics |
| CLI login | `pulse login` via **Device Authorization Grant (RFC 8628)**, ported from chest-gate; mints an org-scoped ingest key | One-command onboarding, SSH/headless-safe; manual keys stay for CI |
| Alert routing | Dedicated org-scoped `pulse_alert_webhooks`; **webhook + email** (Resend) | MCP webhook table is user-scoped; reuse the pattern, not the table |
| Storage | One `Store` seam = **durable Postgres `pulse_nodes` registry ⊕ Redis hot** (snapshot + deadline ZSET); registry-first write | High-freq liveness in Redis; a node never vanishes on TTL lapse (eng-review) |
| Liveness | `deadline = ARRIVAL-time + clamped(interval) + grace`; grace ≥ sweep tick; agent `ts` is metadata only | Heartbeat model; receiver-time defeats clock-skew/malicious-ts (outside-voice) |
| Scheduler / latency | Vercel **Pro** per-minute sweep (hard 60s floor); detection set by period above it (~2–3min pro / ~6–7min free at default grace); sub-minute = QStash/Railway fast-follow | Vercel cron floors at 1 min; idempotent sweep makes it swappable |
| Pricing & limits | Node-based; free **1** node, pro **10**; hard cap in v1; **$2/host/mo** metered add-on as fast-follow | Per-host is the norm; metered billing not built yet (§13) |
| Lapse handling | **Grace + dunning, never instant cut**; terminal → downgrade to free allowance | Cutting a monitor at billing-failure is exactly when they need it (§13) |
| Cadence/cooldown | Per-org DB-backed settings; floors from plan (period free 300s/pro 60s; cooldown free 900s/pro 300s) | Period is the real detection lever above the 60s sweep floor; tunable from floor upward |
| Self-hostable receiver | **Dropped** (contract stays public so others *could* build one) | Backend is commercial |
| Dashboard | Live monitoring in v1 (+ Redis sparklines); history deferred | Covers "I need to monitor"; history is additive |
| Agent model | ≥1 checks per agent (all-must-pass) + optional `group` + per-agent alert-only | Real agents need process AND http; validated on Hermes |
| Templates | Local CLI scaffolding + portal-suggested (copy-in) recipes | Onboarding value without a server→box command channel |
| Control plane | **Not built** — box commands stay in local YAML | Server→box command push is an RCE surface |
| URL | `waydock.ai/pulse` first; `pulse.waydock.ai` later | Same-origin = zero cookie change; subdomain is reversible |
| Node persistence (eng-review) | Durable `pulse_nodes` registry; node leaves only via explicit delete; dead box renders DOWN | A monitor must never silently forget a dead machine |
| Blast radius (eng-review) | Ingest + sweep in a separate Vercel project; shared `@waydock/pulse-server` pkg | Public high-volume path can't degrade the core product |
| Hot-path cost (eng-review) | Cache key→{org,plan,allowance,cidrs} in Redis (~60s); throttle registry upsert | Avoid 2 reads + 1 write to Postgres per heartbeat at scale |
| Sweep dispatch (eng-review) | Bounded-concurrency + per-tick cap + idempotent catch-up + log-when-capped | Mass-silence can't blow the function timeout or silently drop alerts |
| Untrusted interval (eng-review) | Receiver clamps agent-reported `interval` to `[plan floor, 3600s]` | Wire value is user-controlled; prevents tier-bypass + never-silent defeat |
| ZSET scaling (eng-review) | Single global deadline ZSET in v1; documented shard path for scale | Correct + simple now; don't pay for scale with no users |
| Alert delivery (outside-voice) | `pulse_alerts` **outbox** + per-channel state machine + retry/dead-letter (not a boolean) | A paid monitor must *prove* delivery; doubles as incident history |
| Redis durability (outside-voice) | Periodic registry↔Redis **reconciliation** re-detects lost deadlines | Don't silently un-monitor a dead host if Redis drops a member |
| Agent loop (outside-voice) | Heartbeat on an **independent timer**; receiver uses arrival time | A slow restart must not make a live host look dead |
| Watch-the-watchman (outside-voice) | Sweep records `last_swept_at`; external synthetic alerts on staleness | A silently dead cron must not silently kill detection |
| Two-project ops (outside-voice) | Ingest on `ingest.waydock.ai`; main app owns migrations; deploy migrate→app→ingest | Cross-project routing + migration ownership are real, not plumbing |
| Cache safety (outside-voice) | Bust key/plan cache on revoke/plan-change (TTL is backstop); device key encrypted-at-rest | Revocation is security, not "tolerated 60s"; no plaintext keys at rest |
| Node identity (outside-voice) | Reap registry rows unseen N days; rename/reinstall = new node | User-chosen ids churn; don't burn quota forever |
| Sequencing (outside-voice) | Early dogfood gate after the core path, before the commercial layer | Validate the core alarm cheaply before billing/RBAC/login |

---

## 13. Billing, limits & lapse (v1)

**Model:** node-based, bundled into waydock's existing **Free + Pro** plans (`src/lib/billing/plans.ts`),
quota-based rather than a binary feature flag (every plan gets a free node). New `PLANS` quotas:

| Quota | Free | Pro |
|---|---|---|
| `pulseNodesIncluded` | **1** | **10** |
| `pulseMinPeriodSeconds` (min heartbeat period → sets detection cadence) | **300** | **60** |
| `pulseMinCooldownSeconds` (min gap between repeat alerts) | **900** | **300** |
| history retention | ~24h | (later) |

**On the period floors (why 300/60, not 60/20):** detection latency ≈ `period + grace + up to one
60s sweep tick`. The **60s Vercel-cron sweep is the hard floor** — nothing detects faster than that
in v1 — so a sub-60s period (e.g. pro=20s) just over-promises and triples ingest load for no gain.
At 300/60 the period becomes a *real, Vercel-Pro-achievable* tier lever. At the **default grace 60s**:
**free ≈ 6–7 min detection** (`300+60+≤60`), **pro ≈ 2–3 min** (`60+60+≤60`) — broadly the industry
5-min-free / 1-min-paid ladder. Raising grace to tolerate missed beats slows these proportionally.
Users pick the period **from the floor upward** (slower always allowed; faster than the floor is not).
Truly sub-minute detection (below the 60s sweep) is the QStash/Railway fast-follow, where pro could
drop to ~30s.

- **Cap behavior (v1):** **hard cap at the allowance.** A *new* node beyond the allowance is rejected
  `402` at ingest; nodes already within allowance keep reporting — never silently drop a monitored node.
- **Metered overage** (`$2/host/mo` above the allowance) is a **fast-follow** — it needs a Stripe
  metered price + usage reporting (waydock bills per-seat-quantity today). v1 does not bill overage.
- **Cadence/cooldown** are **per-org DB-backed settings**, defaulting from the plan floors above and
  tunable by owner/admin **from the floor upward** (never below). Env is reserved for true infra knobs
  (the sweep's own tick); all user-facing cadence lives in DB settings so `/pulse` edits need no deploy.

**Definitions.** `past_due` is **grace, NOT lapsed** — `getOrgPlan` treats it as entitled (keeps the
paid allowance). **"Lapsed" = `canceled`/`unpaid`**, for which `getOrgPlan` returns `'free'` — so a
lapsed org is just a free org (1-node allowance) automatically; there is no separate lapse state to
track. The downgrade is the act of shedding excess nodes to fit that allowance.

**Lapse flow & comms (grace-based; leverages waydock's existing `past_due`-as-entitled handling):**
- **`active` → `past_due`** (first failed charge — grace): **monitoring + alerts stay fully live.**
  Stripe Smart Retries runs; Resend dunning emails at **day 0 / 3 / 7 / 12**; persistent in-app banner
  on `/pulse` + billing. (`entitlements.ts` already treats `past_due` as entitled — the comment notes
  cutting access mid-workflow is the worst churn trigger.)
- **`past_due` → `canceled`/`unpaid`** (terminal, ~14d): the subscription-canceled **Stripe webhook
  handler runs a one-time downgrade** — keep the **most-recently-active** node (max `lastSeen`) and
  **pause** the rest (set `paused:true` + `ZREM` their deadline members, §5), flagged in UI + a final
  email naming the now-unmonitored hosts. The kept node keeps alerting normally. **Never silently stop
  detecting** on a host the user still believes is watched. (No "skip lapsed orgs" in the sweep — paused
  nodes are simply absent from the ZSET.)
- **Re-subscribe:** allowance returns to Pro; paused nodes un-pause on their next heartbeat (re-added to
  the ZSET), zero agent reconfig.
- The standalone `402` is for **quota** (a new/over-allowance node — including a paused node heartbeating
  while the org is still over allowance), distinct from dunning (which never hard-cuts a node mid-grace).

---

## 14. UI & Design (design-review decisions)

Two screens: the `/pulse` **dashboard** and the `/pulse/device` authorize page. Both **inherit waydock's
design system** — they do not invent a look.

**Design-system inheritance (non-negotiable):** use waydock's CSS tokens (light "warm paper" `--bg #FBFAF7`
/ `--text #1A1814` / navy `--accent #2A4670` / warm borders; dark "Linear-sharp" `#0B0B0C`), its fonts
(Hanken Grotesk sans, JetBrains Mono for metrics/timers/codes, Source Serif 4 for occasional display), the
existing **semantic status colors** (`--success #4D7A3F` = UP, `--warning #B07F2E` = DEGRADED, `--danger
#C53030` = DOWN), `--radius 0.5rem`, the 240px sidebar shell, and **waydock's actual shadcn components**
(Button, Select, etc.) — not reimplementations. Dark mode comes free via the tokens.

**Dashboard IA (approved: dense DOWN-first list — Variant A):** sidebar shell → page header (title · active
org · "Add node") → **summary strip** (down / degraded / up counts + nodes-used-of-allowance) → a single
**operational list sorted DOWN-first**. Each row: status dot+label · node name (Hanken Grotesk) · per-agent
status pips · last-seen (JetBrains Mono) · inline CPU/MEM/DISK bars · restart count · a 🔒 marker for
private nodes. Status reads in a 3-second scan; the DOWN row tints red and the dot pulses. Calm, dense,
minimal chrome — not a card grid. **Auto-refresh** ~10s polling of `/api/pulse/status`, paused when the tab
is hidden (`visibilitychange`).

**Interaction states (design-review fix — full coverage):**

| State | What the user sees |
|---|---|
| UP | green dot + "Up", fresh last-seen, metric bars |
| DEGRADED | amber dot + "Degraded" (some checks failing / metrics hot) |
| DOWN | red pulsing dot + "Down", `silent Nm Ns` in red, sorted to top, row tinted |
| **Pending / no-data** | **grey** dot + "Pending — waiting for first heartbeat" (registry row exists, no hot snapshot yet, or snapshot expired) — honest, never falsely green/red |
| Loading | **skeleton rows** (preserve layout), not a spinner |
| Error (fetch failed) | inline **retry banner** above the last-known list — never a blank screen |
| Empty (first run) | onboarding *is* the empty state: "Watch your first box" + the one obvious action `npx @waydock/pulse login` + the free-1/pro-10 note |

**Responsive + accessibility (design-review fix):**
- **Mobile** (`<768px`): sidebar → top bar + hamburger (waydock's `--mobile-topbar-height`); each node
  becomes a **stacked card** — line 1 status+name, line 2 last-seen+restarts, metrics collapse to one
  sparkline, tap to expand. 44px touch targets.
- **A11y:** status is **never color-alone** — always the text label (UP/DEGRADED/DOWN) + a distinct dot
  shape/icon; full keyboard nav + ARIA landmarks; an **ARIA live region announces a node going DOWN** for
  screen readers; honor `prefers-reduced-motion` (disable the DOWN pulse). Body text ≥16px, contrast ≥4.5:1
  (waydock tokens already pass).

**`/pulse/device` authorize page:** centered card on the warm-paper shell — the 8-char `user_code` large in
JetBrains Mono, "Authorize this machine?" + hostname + requested/expires time, an **org picker** (only when
the user is in >1 org), Authorize / "Not me — deny" buttons, and a trust line ("mints a scoped key for this
machine only · revocable anytime"). On approve: "You can return to your terminal."

**Deferred (NOT in v1 design scope):** a node **detail drawer/page** (click-through to history, restart log,
metric charts) — the row is clickable but v1 opens nothing heavy; pairs with the deferred Postgres history.

### Approved Mockups

| Screen | Mockup path | Direction |
|---|---|---|
| Dashboard | `~/.gstack/projects/smd00-waydock-pulse/designs/pulse-ui-20260611/dashboard-a.html` | Dense DOWN-first list (approved) |
| Empty / first-run | `…/pulse-ui-20260611/dashboard-empty.html` | Onboarding-as-empty-state |
| Device authorize | `…/pulse-ui-20260611/device.html` | Code + hostname + org picker + trust line |
| (alt) Attention-grouped | `…/pulse-ui-20260611/dashboard-b.html` | Considered, not chosen |

---

## Implementation Tasks
Synthesized from the eng-review + outside-voice findings. Each derives from a specific finding.
Run with Claude Code or Codex; checkbox as you ship. (P1 blocks ship · P2 same branch · P3 follow-up.)

- [ ] **T1 (P1, human ~1d / CC ~1h)** — store — Durable `pulse_nodes` registry + registry-first→atomic-Redis write + dead=DOWN LEFT JOIN. (Issues 1/5)
- [ ] **T2 (P1, human ~4h / CC ~30m)** — ingest — Receiver arrival-time as liveness truth + clamp `interval` to `[floor,3600]`. (Issue 2 + outside #1)
- [ ] **T3 (P1, human ~4h / CC ~25m)** — agent — Decouple heartbeat sender onto an independent timer from check/restart. (outside #16)
- [ ] **T4 (P1, human ~1d / CC ~1h)** — sweep — `pulse_alerts` outbox: per-channel delivery state machine + retry + dead-letter. (outside #5/#13)
- [ ] **T5 (P1, human ~4h / CC ~30m)** — sweep — Periodic (~5min) registry↔Redis reconciliation for lost ZSET members. (outside #4)
- [ ] **T6 (P1, human ~3h / CC ~20m)** — store — Recovery-vs-silence Lua compare-and-set atomicity. (eng-review)
- [ ] **T7 (P1, human ~4h / CC ~30m)** — security — RLS isolation + one org-scoping helper everywhere + cross-tenant tests. (outside #3)
- [ ] **T8 (P2, human ~2d / CC ~2h)** — infra — Split `pulse-ingest` Vercel project + extract `@waydock/pulse-server` + `ingest.waydock.ai` + migration ownership/deploy order. (Issue 3 + outside #2/#7)
- [ ] **T9 (P2, human ~4h / CC ~30m)** — ingest — Redis cache key+entitlement (~60s) + throttle registry upsert + cache-bust on revoke. (Issue 6 + outside #9)
- [ ] **T10 (P2, human ~3h / CC ~20m)** — sweep — Bounded-concurrency dispatch + per-tick cap + log-when-capped. (Issue 4)
- [ ] **T11 (P2, human ~3h / CC ~20m)** — ops — Sweep self-monitoring: `last_swept_at` + external synthetic staleness alert. (outside #15)
- [ ] **T12 (P2, human ~2h / CC ~15m)** — device-grant — Encrypt held device-grant key at rest; clear on consume. (outside #8)
- [ ] **T13 (P2, human ~2h / CC ~15m)** — alerting — Cooldown scoped per-node-per-event-type; never suppress recovery/other node. (outside #14)
- [ ] **T14 (P2, human ~4h / CC ~30m)** — billing — Downgrade reads Redis `lastSeen`; reap registry rows unseen N days. (outside #10/#11)
- [ ] **T15 (P2, process)** — Early dogfood gate: prove the core alarm on the Mac mini before the commercial layer. (outside #18)
- [ ] **T16 (P3)** — scale — ZSET sharding (documented, deferred until hotspot). (Issue 7)
- [ ] **T17 (P3)** — billing — Metered $2/host overage (Stripe metered price) fast-follow. (§13)
- [ ] **T18 (P3)** — latency — Sub-minute detection via QStash/Railway fast-follow. (§2)
- [ ] **T19 (P1, human ~1d / CC ~1h)** — dashboard — Build `/pulse` (Variant A: sidebar shell + summary strip + DOWN-first list) on waydock's shadcn components + tokens; ~10s polling paused on hidden tab. (§14, Pass 1)
- [ ] **T20 (P1, human ~4h / CC ~30m)** — dashboard-states — All interaction states: pending/no-data grey row, skeleton loading, inline error banner, empty/onboarding. (§14, Pass 2)
- [ ] **T21 (P1, human ~5h / CC ~40m)** — responsive-a11y — Mobile stacked-card layout + hamburger; status-not-by-color, keyboard/ARIA + DOWN live-region, prefers-reduced-motion, 44px targets. (§14, Pass 6)
- [ ] **T22 (P2, human ~3h / CC ~20m)** — device-page — `/pulse/device` authorize screen (code, hostname, org picker, trust line, post-approve state). (§14)
- [ ] **T23 (P3)** — node-detail — Detail drawer (history/restart-log/charts); pairs with deferred Postgres history. (§14 deferred)

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (optional) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 16 issues, 0 critical gaps; all resolved into the spec |
| Outside Voice | codex (`codex exec`) | Independent 2nd opinion | 1 | issues_found | 20 raised; 13 adopted, 4 already-decided, 3 deferred |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | 3/10 → 9/10; 5 decisions; mockups approved (Variant A) |

- **CODEX:** 20 findings; the review's two correctness misses (receiver-time liveness, heartbeat-decoupled-from-restart) + alert-delivery outbox + Redis-reconciliation + 9 hardening fixes were adopted; scope/pricing/sequencing-as-cut were already user-decided (sequencing adopted as an early dogfood gate).
- **CROSS-MODEL:** Eng-review + outside-voice converged on the core-mechanism gaps (liveness truth, delivery durability, Redis as sole source). No unresolved disagreement.
- **DESIGN:** dashboard IA + full state table + responsive/a11y specified in §14, calibrated to waydock's tokens; mockups (Variant A dense list, empty/onboarding, device page) approved and pathed. Node-detail drawer deferred.
- **UNRESOLVED:** 0.
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement. No CEO review needed (scope/pricing locked this session). Next: `writing-plans` to turn T1–T23 into the detailed implementation plan.
