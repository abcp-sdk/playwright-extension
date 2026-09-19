import { servePlaywright } from './serve.js'

/** Read a positive integer env var, or a default. */
function intEnv(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return def
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : def
}

function viewportEnv(): { width: number; height: number } | null {
  const raw = process.env['PLAYWRIGHT_VIEWPORT']
  if (raw === undefined || raw.trim() === '') return null
  const m = /^(\d+)x(\d+)$/.exec(raw.trim())
  if (m === null) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

async function main(): Promise<void> {
  const natsUrl = process.env['NATS_URL'] ?? 'nats://127.0.0.1:4222'
  const cdpEndpoint = process.env['PLAYWRIGHT_CDP_ENDPOINT'] ?? ''
  if (cdpEndpoint === '') {
    throw new Error(
      'PLAYWRIGHT_CDP_ENDPOINT is required (a Chromium/CDP endpoint, e.g. the Selenium node CDP URL or http://chrome:9222)',
    )
  }

  const { stop } = await servePlaywright({
    natsUrl,
    extension: {
      cdpEndpoint,
      viewport: viewportEnv(),
      ignoreHttpsErrors: process.env['PLAYWRIGHT_IGNORE_HTTPS_ERRORS'] !== 'false',
      idleTimeoutMs: intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000),
      maxContexts: intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8),
      defaultTimeoutMs: intEnv('PLAYWRIGHT_ACTION_TIMEOUT_MS', 30_000),
    },
  })

  console.log(
    `[playwright] serving over ${natsUrl} -> CDP ${cdpEndpoint} (idle=${intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000)}ms, max=${intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8)})`,
  )

  const shutdown = (): void => {
    void stop().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

void main().catch((e: unknown) => {
  console.error('[playwright] fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
