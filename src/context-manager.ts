import type { Browser, BrowserContext, Page } from 'playwright-core'

/**
 * One browser context, keyed by an opaque `context_id`. A context is created
 * by `browser-create-context` (which mints the key) and used by every other
 * tool through that key. Contexts are scoped to a (tenant, session) pair so a
 * key minted in one tenant/session can never be used from another.
 */
export interface BrowserSession {
  contextId: string
  tenant: string
  session: string
  /** Selenium WebDriver session id (DELETE to close) — null for a raw CDP. */
  driverSessionId: string | null
  browser: Browser
  context: BrowserContext
  page: Page
  createdAt: number
  lastUsedAt: number
  /** Per-context serialization: one tool action at a time. */
  busy: boolean
}

export interface ContextManagerOpts {
  /** Close a context after this many ms without a tool call (0 disables). */
  idleTimeoutMs: number
  /** Hard cap on live contexts; creating beyond it evicts the LRU idle one. */
  maxContexts: number
  /** Create the underlying browser session (Selenium/WebDriver or raw CDP). */
  createBrowser: () => Promise<{
    browser: Browser
    context: BrowserContext
    page: Page
    driverSessionId: string | null
  }>
  /** Tear the underlying browser session down. */
  destroyBrowser: (s: BrowserSession) => Promise<void>
  onError?: (err: unknown, ctx: string) => void
}

/**
 * Owns the live browser contexts: creation, lookup (with tenant/session
 * checks), LRU eviction, and idle reaping. Actions route through [withContext]
 * so a context is only touched by one tool call at a time and its `lastUsedAt`
 * is refreshed.
 */
export class ContextManager {
  private readonly sessions = new Map<string, BrowserSession>()
  private reaper: ReturnType<typeof setInterval> | undefined

  constructor(private readonly opts: ContextManagerOpts) {}

  start(): void {
    if (this.opts.idleTimeoutMs <= 0 || this.reaper !== undefined) return
    // Sweep at a fraction of the idle window so a context is closed within
    // ~1.2x its idle timeout of going unused.
    const period = Math.max(15_000, Math.floor(this.opts.idleTimeoutMs / 4))
    this.reaper = setInterval(() => {
      void this.reapIdle()
    }, period)
    this.reaper.unref?.()
  }

  async stop(): Promise<void> {
    if (this.reaper !== undefined) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map(s => this.destroy(s)))
  }

  size(): number {
    return this.sessions.size
  }

  /** Create a context and return its minted key. */
  async create(tenant: string, session: string): Promise<string> {
    if (
      this.opts.maxContexts > 0 &&
      this.sessions.size >= this.opts.maxContexts
    ) {
      await this.evictLru()
    }
    const { browser, context, page, driverSessionId } =
      await this.opts.createBrowser()
    const contextId = crypto.randomUUID()
    const now = Date.now()
    this.sessions.set(contextId, {
      contextId,
      tenant,
      session,
      driverSessionId,
      browser,
      context,
      page,
      createdAt: now,
      lastUsedAt: now,
      busy: false,
    })
    return contextId
  }

  /**
   * Resolve a context for the caller, enforcing that the key belongs to the
   * same (tenant, session). Throws on unknown/foreign keys.
   */
  get(contextId: string, tenant: string, session: string): BrowserSession {
    const s = this.sessions.get(contextId)
    if (s === undefined) {
      throw new Error(
        `unknown context_id ${contextId} (it may have been reaped for inactivity — call browser-create-context again)`,
      )
    }
    if (s.tenant !== tenant || (session !== '' && s.session !== session)) {
      throw new Error(`context_id ${contextId} does not belong to this session`)
    }
    return s
  }

  /** Serialize access to one context and refresh its liveness. */
  async withContext<T>(
    contextId: string,
    tenant: string,
    session: string,
    fn: (s: BrowserSession) => Promise<T>,
  ): Promise<T> {
    const s = this.get(contextId, tenant, session)
    while (s.busy) await new Promise(r => setTimeout(r, 25))
    s.busy = true
    s.lastUsedAt = Date.now()
    try {
      return await fn(s)
    } finally {
      s.busy = false
      s.lastUsedAt = Date.now()
    }
  }

  /** Explicitly close a context (browser-close-context). */
  async close(
    contextId: string,
    tenant: string,
    session: string,
  ): Promise<void> {
    const s = this.get(contextId, tenant, session)
    this.sessions.delete(contextId)
    await this.destroy(s)
  }

  /** Close every context belonging to a session (lifecycle: deleted). Returns
   *  the number closed. */
  async closeSession(tenant: string, session: string): Promise<number> {
    const doomed = [...this.sessions.values()].filter(
      s => s.tenant === tenant && s.session === session,
    )
    for (const s of doomed) this.sessions.delete(s.contextId)
    await Promise.all(doomed.map(s => this.destroy(s)))
    return doomed.length
  }

  /** Close contexts idle beyond the configured timeout. */
  async reapIdle(): Promise<void> {
    if (this.opts.idleTimeoutMs <= 0) return
    const cutoff = Date.now() - this.opts.idleTimeoutMs
    const doomed = [...this.sessions.values()].filter(
      s => !s.busy && s.lastUsedAt < cutoff,
    )
    for (const s of doomed) this.sessions.delete(s.contextId)
    await Promise.all(doomed.map(s => this.destroy(s)))
  }

  private async evictLru(): Promise<void> {
    const idle = [...this.sessions.values()]
      .filter(s => !s.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const victim = idle[0]
    if (victim === undefined) return
    this.sessions.delete(victim.contextId)
    await this.destroy(victim)
  }

  private async destroy(s: BrowserSession): Promise<void> {
    // The in-pod driver session is torn down by destroyBrowser (DELETE
    // /session for WebDriver, or closing the CDP connection).
    await this.opts.destroyBrowser(s).catch(e => {
      this.opts.onError?.(e, `destroy ${s.contextId}`)
    })
  }
}
