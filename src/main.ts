import { createServer } from 'node:http'
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
  const seleniumUrl = process.env['PLAYWRIGHT_SELENIUM_URL'] ?? ''
  const cdpEndpoint = process.env['PLAYWRIGHT_CDP_ENDPOINT'] ?? ''
  if (seleniumUrl === '' && cdpEndpoint === '') {
    throw new Error(
      'one of PLAYWRIGHT_SELENIUM_URL (Selenium/standalone-chrome base URL) or PLAYWRIGHT_CDP_ENDPOINT (raw CDP endpoint) is required',
    )
  }
  const target: import('./index.js').BrowserTarget =
    seleniumUrl !== ''
      ? {
          kind: 'selenium',
          baseUrl: seleniumUrl,
          browserName: process.env['PLAYWRIGHT_BROWSER'] ?? 'chrome',
          cdpTimeoutMs: intEnv('PLAYWRIGHT_CDP_TIMEOUT_MS', 30_000),
        }
      : { kind: 'cdp', endpoint: cdpEndpoint }

  const { stop } = await servePlaywright({
    natsUrl,
    extension: {
      target,
      viewport: viewportEnv(),
      ignoreHttpsErrors: process.env['PLAYWRIGHT_IGNORE_HTTPS_ERRORS'] !== 'false',
      idleTimeoutMs: intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000),
      maxContexts: intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8),
      defaultTimeoutMs: intEnv('PLAYWRIGHT_ACTION_TIMEOUT_MS', 30_000),
    },
  })

  console.log(
    `[playwright] serving over ${natsUrl} -> ${
      seleniumUrl !== '' ? `selenium ${seleniumUrl}` : `cdp ${cdpEndpoint}`
    } (idle=${intEnv('PLAYWRIGHT_IDLE_TIMEOUT_MS', 600_000)}ms, max=${intEnv('PLAYWRIGHT_MAX_CONTEXTS', 8)})`,
  )

  // Minimal HTTP surface for Kubernetes probes (the extension itself speaks
  // only the abc protocol over NATS).
  const port = intEnv('PORT', 8080)
  const http = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/health') {
      res.end(JSON.stringify({ ok: true, id: 'playwright' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  http.listen(port, () => console.log(`[playwright] http :${port}`))

  const shutdown = (): void => {
    http.close()
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
