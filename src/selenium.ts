import { chromium, type Browser, type Page } from 'playwright-core'

/**
 * Creates browser sessions by talking to a Selenium (Grid / standalone-chrome)
 * node over its WebDriver HTTP API.
 *
 * Selenium does NOT expose a raw browser-level CDP URL up front: you create a
 * WebDriver session and the response carries the `se:cdp` capability (a CDP
 * endpoint Playwright can attach to). So each context:
 *   1. POST {base}/session            -> sessionId + capabilities['se:cdp']
 *   2. chromium.connectOverCDP(se:cdp)
 *   3. DELETE {base}/session/{id}     on close
 *
 * A raw CDP endpoint (headless Chrome with --remote-debugging-port, browserless)
 * uses [CdpBrowserFactory] instead.
 */
export interface SeleniumBrowserFactoryOpts {
  /** Selenium base URL, e.g. http://selenium:4444 or /wd/hub. */
  baseUrl: string
  /** Browser name for the WebDriver session (default 'chrome'). */
  browserName: string
  /** Per-context viewport (null = driver default). */
  viewport: { width: number; height: number } | null
  /** Ignore HTTPS errors on the browser side. */
  ignoreHttpsErrors: boolean
  /** Overall CDP attach timeout. */
  cdpTimeoutMs: number
}

interface SeleniumSession {
  sessionId: string
  cdpUrl: string
  browser: Browser
  page: Page
}

export class SeleniumBrowserFactory {
  constructor(private readonly opts: SeleniumBrowserFactoryOpts) {}

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`
  }

  /** Create a WebDriver session and attach Playwright over its se:cdp URL. */
  async create(): Promise<SeleniumSession> {
    const res = await fetch(this.url('/session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            browserName: this.opts.browserName,
            'se:cdp': true,
            'se:cdpVersion': '1.3',
            // Playwright drives the browser over CDP; keep the Grid from
            // rejecting the attach with its default origin checks.
            'goog:chromeOptions': {
              args: ['--no-sandbox', '--disable-dev-shm-usage'],
            },
          },
        },
      }),
    })
    if (!res.ok) {
      throw new Error(
        `selenium create session failed: ${res.status} ${await res.text()}`,
      )
    }
    const body = (await res.json()) as {
      value?: {
        sessionId?: string
        capabilities?: Record<string, unknown>
      }
      sessionId?: string
    }
    const value = body.value ?? {}
    const sessionId = String(value.sessionId ?? body.sessionId ?? '')
    const caps = value.capabilities ?? {}
    const cdpUrl = String(caps['se:cdp'] ?? '')
    if (sessionId === '' || cdpUrl === '') {
      // Do not leak the session if we cannot attach.
      if (sessionId !== '') await this.deleteSession(sessionId).catch(() => {})
      throw new Error(
        'selenium session missing se:cdp — the node must be Selenium 4.11+ with CDP enabled',
      )
    }

    const browser = await chromium.connectOverCDP(cdpUrl, {
      timeout: this.opts.cdpTimeoutMs,
    })
    // Reuse the driver-created context/page (the session owns the browser);
    // create one if the node started with none.
    const contexts = browser.contexts()
    let context = contexts[0]
    if (context === undefined) {
      context = await browser.newContext({
        ...(this.opts.viewport !== null ? { viewport: this.opts.viewport } : {}),
        ignoreHTTPSErrors: this.opts.ignoreHttpsErrors,
      })
    }
    const pages = context.pages()
    const page =
      pages[0] ??
      (await context.newPage())
    page.setDefaultTimeout(30_000)
    return { sessionId, cdpUrl, browser, page }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await fetch(this.url(`/session/${sessionId}`), { method: 'DELETE' })
  }
}
