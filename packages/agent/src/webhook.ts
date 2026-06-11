export type AlertKind = 'down' | 'up' | 'restart-recovered' | 'restart-failed'

export interface AlertEvent {
  node: string
  agent: string
  kind: AlertKind
  ts: number
  detail?: string
}

export interface WebhookDeps {
  fetch?: typeof fetch
}

const kindMeta: Record<AlertKind, { emoji: string; verb: string }> = {
  'down':              { emoji: '🔴', verb: 'went down' },
  'up':                { emoji: '🟢', verb: 'recovered' },
  'restart-recovered': { emoji: '✅', verb: 'auto-restarted' },
  'restart-failed':    { emoji: '🚨', verb: 'restart FAILED' },
}

export async function sendLocalAlert(
  url: string | undefined,
  ev: AlertEvent,
  deps: WebhookDeps = {},
): Promise<void> {
  if (!url) return

  const { emoji, verb } = kindMeta[ev.kind]
  let message = `${emoji} ${ev.node} · ${ev.agent} ${verb}`
  if (ev.detail) message += ` — ${ev.detail}`

  const isDiscord =
    url.includes('discord.com/api/webhooks') ||
    url.includes('discordapp.com/api/webhooks')

  const bodyObj = isDiscord
    ? { content: message }
    : { ...ev, message }

  const fetchFn = deps.fetch ?? fetch

  try {
    await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // best-effort — swallow all network/timeout errors
  }
}
