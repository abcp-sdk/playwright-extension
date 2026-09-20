import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bus } from '@abc-protocol/sdk'
import { CONFIG_SELENIUM_URL, createPlaywrightExtension } from '../src/index.js'

const fakeBus = {} as unknown as Bus

function build(getConfig: (name: string, session?: string, tenant?: string) => unknown) {
  return createPlaywrightExtension(fakeBus, {
    target: { kind: 'selenium', baseUrl: 'http://env-selenium:4444', browserName: 'chrome', cdpTimeoutMs: 30_000 },
    viewport: null,
    ignoreHttpsErrors: true,
    idleTimeoutMs: 0,
    maxContexts: 1,
    defaultTimeoutMs: 30_000,
    getConfig,
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('playwright selenium-url config', () => {
  it('advertises the selenium-url knob', () => {
    const { config } = build(() => '')
    expect(config.config?.[CONFIG_SELENIUM_URL]?.type).toBe('string')
    expect(config.config?.[CONFIG_SELENIUM_URL]?.descriptions?.zh).toBeTruthy()
  })

  it('uses the configured URL (config overrides the env target)', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      throw new Error('stop-here')
    })
    const bundle = build(() => 'http://cfg-selenium:4444')
    const exec = bundle.config.tools?.['browser-create-context']?.execute
    await exec!({}, 'c1', 'sess-1', undefined, 'tenant-a').catch(() => {})
    expect(urls[0]).toContain('http://cfg-selenium:4444/session')
  })

  it('falls back to the env target when config is empty', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      throw new Error('stop-here')
    })
    const bundle = build(() => '')
    const exec = bundle.config.tools?.['browser-create-context']?.execute
    await exec!({}, 'c1', 'sess-1', undefined, 'tenant-a').catch(() => {})
    expect(urls[0]).toContain('http://env-selenium:4444/session')
  })
})
