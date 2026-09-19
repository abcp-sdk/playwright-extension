import { describe, expect, it, vi } from 'vitest'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { ContextManager, type ContextManagerOpts } from '../src/context-manager.js'

/** A fake browser session factory counting creates/destroys. */
function fakeFactory() {
  let created = 0
  let destroyed = 0
  const createBrowser: ContextManagerOpts['createBrowser'] = async () => {
    created++
    const page = {} as Page
    const context = { pages: () => [page] } as unknown as BrowserContext
    const browser = {} as Browser
    return { browser, context, page, driverSessionId: null }
  }
  const destroyBrowser: ContextManagerOpts['destroyBrowser'] = async () => {
    destroyed++
  }
  return {
    createBrowser,
    destroyBrowser,
    stats: () => ({ created, destroyed }),
  }
}

function manager(over: Partial<ContextManagerOpts> = {}) {
  const f = fakeFactory()
  const m = new ContextManager({
    idleTimeoutMs: 0,
    maxContexts: 0,
    createBrowser: f.createBrowser,
    destroyBrowser: f.destroyBrowser,
    ...over,
  })
  return { m, f }
}

describe('ContextManager', () => {
  it('mints unique keys and isolates them by (tenant, session)', async () => {
    const { m } = manager()
    const id = await m.create('tenant-a', 'sess-1')
    expect(m.get(id, 'tenant-a', 'sess-1').contextId).toBe(id)

    // A different tenant/session cannot use the key.
    expect(() => m.get(id, 'tenant-b', 'sess-1')).toThrow(/does not belong/)
    expect(() => m.get(id, 'tenant-a', 'sess-2')).toThrow(/does not belong/)
    expect(() => m.get('nope', 'tenant-a', 'sess-1')).toThrow(/unknown context_id/)
    await m.stop()
  })

  it('reaps contexts idle beyond the timeout', async () => {
    vi.useFakeTimers()
    try {
      const { m, f } = manager({ idleTimeoutMs: 1000 })
      const id = await m.create('t', 's')
      expect(m.size()).toBe(1)
      m.get(id, 't', 's').lastUsedAt = Date.now() - 10_000
      await m.reapIdle()
      expect(m.size()).toBe(0)
      expect(f.stats().destroyed).toBe(1)
      await m.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('LRU-evicts an idle context when at the cap', async () => {
    const { m, f } = manager({ maxContexts: 2 })
    const a = await m.create('t', 's')
    m.get(a, 't', 's').lastUsedAt = 1000
    await m.create('t', 's') // second fills the cap
    expect(m.size()).toBe(2)
    await m.create('t', 's') // third evicts the LRU (a)
    expect(m.size()).toBe(2)
    expect(() => m.get(a, 't', 's')).toThrow(/unknown context_id/)
    expect(f.stats().destroyed).toBe(1)
    await m.stop()
  })

  it('closes every context belonging to a deleted session', async () => {
    const { m, f } = manager()
    const a = await m.create('t', 'sess-x')
    await m.create('t', 'sess-y')
    await m.closeSession('t', 'sess-x')
    expect(m.size()).toBe(1)
    expect(() => m.get(a, 't', 'sess-x')).toThrow(/unknown context_id/)
    expect(f.stats().destroyed).toBe(1)
    await m.stop()
  })
})
