import { afterAll, describe, expect, it } from 'vitest'
import { Agent, connectNatsBus, start } from '@abc-protocol/sdk'
import { servePlaywright } from '../src/serve.js'

const LIVE_NATS = process.env['LIVE_NATS_URL'] ?? ''
const CDP = process.env['LIVE_CDP'] ?? ''
const maybe = LIVE_NATS === '' || CDP === '' ? describe.skip : describe

/**
 * End-to-end against a raw CDP endpoint (headless Chrome / browserless). Set
 * LIVE_NATS_URL + LIVE_CDP to run; skipped otherwise. Uses an in-process NATS
 * so no cluster access is required.
 */
maybe('live e2e: extension against a CDP browser', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) await s().catch(() => {})
  })

  it('create -> navigate -> snapshot -> screenshot -> close', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`
    stops.push(() => server.stop())
    const { stop } = await servePlaywright({
      natsUrl: url,
      extension: {
        target: { kind: 'cdp', endpoint: CDP },
        viewport: { width: 1280, height: 720 },
        ignoreHttpsErrors: true,
        idleTimeoutMs: 0,
        maxContexts: 4,
        defaultTimeoutMs: 20_000,
      },
    })
    stops.push(stop)
    const bus = await connectNatsBus(url)
    stops.push(() => bus.close())
    const agent = new Agent(bus)
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await agent.callTool(
        'default',
        'sess-e2e',
        'playwright',
        tool,
        `c-${Math.random()}`,
        args,
      )
      if (r.error) throw new Error(`${tool}: ${JSON.stringify(r.error)}`)
      return r
    }

    const created = await call('browser-create-context', {})
    const cid = (created.data as { context_id?: string } | null)?.context_id
    expect(cid).toMatch(/^[0-9a-f-]{36}$/)

    await call('browser-navigate', {
      context_id: cid,
      url: 'data:text/html,<h1>E2E</h1><button>Go</button>',
    })
    const snap = await call('browser-snapshot', { context_id: cid })
    expect(snap.content).toContain('E2E')

    const shot = await call('browser-take-screenshot', { context_id: cid })
    const file = (shot.data as { file?: string } | null)?.file ?? ''
    expect(file).toMatch(/^file:[0-9a-f]{16}$/)

    // Explicit close.
    await call('browser-close-context', { context_id: cid })
    // A second close of the same id must fail (unknown context).
    await expect(
      call('browser-close-context', { context_id: cid }),
    ).rejects.toThrow()
  }, 120_000)
})
