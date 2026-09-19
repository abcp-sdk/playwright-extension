import { afterAll, describe, expect, it } from 'vitest'
import { ExtensionManifestSchema, connectNatsBus, start } from '@abc-protocol/sdk'
import { servePlaywright } from '../src/serve.js'

/**
 * Registration smoke test: the extension must be discoverable over the bus and
 * advertise the full official tool set. Uses the SDK's managed in-process
 * nats-server (auto-stopped) — no external broker. No browser is required for
 * registration, so this runs anywhere.
 */
describe('playwright extension registration', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) await s().catch(() => {})
  })

  it('is discoverable and advertises the tools', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`

    const { stop } = await servePlaywright({
      natsUrl: url,
      extension: {
        cdpEndpoint: 'http://127.0.0.1:9222',
        viewport: null,
        ignoreHttpsErrors: true,
        idleTimeoutMs: 0,
        maxContexts: 4,
        defaultTimeoutMs: 30_000,
      },
    })
    stops.push(stop, () => server.stop())

    const bus = await connectNatsBus(url)
    stops.push(() => bus.close())

    // Discovery is a broadcast; allow a couple of attempts for the reply to
    // land after the server has subscribed.
    let manifest = null
    for (let i = 0; i < 5 && manifest === null; i++) {
      const replies = await bus.requestMany('abc.discover', {}, {
        maxWaitMs: 800,
        tenant: 'global',
      })
      for (const env of replies) {
        const p = ExtensionManifestSchema.safeParse(env.payload)
        if (p.success && p.data.id === 'playwright') manifest = p.data
      }
    }
    expect(manifest).not.toBeNull()
    const names = (manifest?.tools ?? []).map(t => t.name)
    expect(names).toContain('browser_create_context')
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_snapshot')
    expect(names).toContain('browser_take_screenshot')
    // Every non-create tool requires context_id.
    const navigate = (manifest?.tools ?? []).find(t => t.name === 'browser_navigate')
    expect(navigate?.input_schema?.required).toContain('context_id')
  })
})
