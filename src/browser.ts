import { chromium, type Browser, type Page } from 'playwright-core'

/**
 * Creates browser sessions keyed by context_id. The extension is configured
 * with a single CDP endpoint (a Chrome/Chromium debugging endpoint, e.g. a
 * `selenium/standalone-chrome` node's browser-level CDP URL, or a headless
 * Chromium's `--remote-debugging-port`): every context opens a NEW, isolated
 * `BrowserContext` (+ page) on the shared browser, which is what gives each
 * `context_id` its own cookies/storage without a second browser process.
 *
 * Playwright only speaks CDP (not WebDriver). A Selenium Grid node exposes a
 * browser-level CDP endpoint once a driver session is up; point `cdp_endpoint`
 * at that URL. A headless Chromium started with
 * `--remote-debugging-port=9222` exposes `http://host:9222` directly.
 */
export interface CdpBrowserFactoryOpts {
  /** CDP endpoint, e.g. http://chrome:9222 or ws://…/devtools/browser/<id>. */
  endpoint: string
  /** Per-context viewport (null = browser/context default). */
  viewport: { width: number; height: number } | null
  /** Ignore HTTPS errors (self-signed dev certs). */
  ignoreHttpsErrors: boolean
  /** Extra HTTP headers on every context. */
  extraHTTPHeaders?: Record<string, string>
}

export class CdpBrowserFactory {
  private browser: Browser | null = null
  private connecting: Promise<Browser> | null = null

  constructor(private readonly opts: CdpBrowserFactoryOpts) {}

  /** Lazily connect to the CDP endpoint; reused across contexts. */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== null && this.browser.isConnected()) {
      return this.browser
    }
    if (this.connecting !== null) return this.connecting
    this.connecting = chromium
      .connectOverCDP(this.opts.endpoint, { timeout: 30_000 })
      .then(b => {
        this.browser = b
        this.connecting = null
        b.on('disconnected', () => {
          this.browser = null
        })
        return b
      })
      .catch(e => {
        this.connecting = null
        throw e
      })
    return this.connecting
  }

  /** Open an isolated context + page for a new context_id. */
  async create(): Promise<{ browser: Browser; page: Page }> {
    const browser = await this.ensureBrowser()
    const context = await browser.newContext({
      ...(this.opts.viewport !== null
        ? { viewport: this.opts.viewport }
        : {}),
      ignoreHTTPSErrors: this.opts.ignoreHttpsErrors,
      ...(this.opts.extraHTTPHeaders !== undefined
        ? { extraHTTPHeaders: this.opts.extraHTTPHeaders }
        : {}),
    })
    context.setDefaultTimeout(30_000)
    context.setDefaultNavigationTimeout(60_000)
    const page = await context.newPage()
    return { browser, page }
  }

  async closePage(page: Page): Promise<void> {
    // Closing the BrowserContext tears down its pages; done by the caller.
    await page.context().close().catch(() => {})
  }

  async disconnect(): Promise<void> {
    const b = this.browser
    this.browser = null
    if (b !== null) await b.close().catch(() => {})
  }
}
