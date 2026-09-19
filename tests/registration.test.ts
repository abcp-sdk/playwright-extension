import { afterAll, describe, expect, it } from 'vitest'
import { ExtensionManifestSchema, connectNatsBus, start } from '@abc-protocol/sdk'
import { servePlaywright } from '../src/serve.js'
import { pwTools } from '../src/tools/browser.js'

/**
 * Registration smoke test: the extension must be discoverable over the bus and
 * advertise exactly the curated tool set (28 tools). Uses the SDK's managed
 * in-process nats-server (auto-stopped) — no external broker.
 */
describe('playwright extension registration', () => {
  const stops: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const s of stops) await s().catch(() => {})
  })

  it('is discoverable and advertises the curated tools', async () => {
    const server = await start({ storage: 'memory' })
    const url = `nats://127.0.0.1:${server.port}`

    const { stop } = await servePlaywright({
      natsUrl: url,
      extension: {
        target: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' },
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
    const names = (manifest?.tools ?? []).map(t => t.name).sort()

    // Exactly the curated set — no underscore names, no dropped wrappers.
    const expected = Object.keys(pwTools()).sort()
    expect(names).toEqual(expected)
    expect(names).toHaveLength(28)
    expect(names.every(n => /^[a-z0-9-]+$/.test(n))).toBe(true)

    // Required anchors.
    for (const n of [
      'browser-create-context',
      'browser-close-context',
      'browser-navigate',
      'browser-snapshot',
      'browser-take-screenshot',
      'browser-pdf-save',
      'browser-run-code-unsafe',
    ]) {
      expect(names).toContain(n)
    }
    // Dropped wrappers must NOT be advertised.
    for (const n of [
      'browser-mouse-click-xy',
      'browser-verify-text-visible',
      'browser-cookie-set',
      'browser-route',
      'browser-emulate-media',
    ]) {
      expect(names).not.toContain(n)
    }

    // Every non-create tool requires context_id.
    const navigate = (manifest?.tools ?? []).find(
      t => t.name === 'browser-navigate',
    )
    expect(navigate?.input_schema?.required).toContain('context_id')
  })
})
