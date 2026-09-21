import type { ExtensionConfig, ToolSpec } from '@abc-protocol/sdk'
import { CdpBrowserFactory } from './browser.js'
import {
  type BrowserSession,
  ContextManager,
  type ContextManagerOpts,
} from './context-manager.js'
import type { PlaywrightDeps } from './deps.js'
import { agentFileDeps } from './deps.js'
import { localeOf, tr } from './i18n.js'
import { SeleniumBrowserFactory } from './selenium.js'
import {
  type ContextLogs,
  newContextLogs,
  pwTools,
  type ToolCtx,
  wirePageLogging,
} from './tools/browser.js'

export * from './browser.js'
export * from './context-manager.js'
export * from './deps.js'
export * from './selenium.js'
export * from './tools/browser.js'

/** How the extension reaches the browser. */
export type BrowserTarget =
  | {
      /** Selenium (Grid/standalone-chrome) WebDriver base URL. */
      kind: 'selenium'
      baseUrl: string
      browserName: string
      cdpTimeoutMs: number
    }
  | {
      /** Raw CDP endpoint (headless Chrome / browserless). */
      kind: 'cdp'
      endpoint: string
    }

export interface PlaywrightExtensionOpts {
  /** Fallback browser target when extension config sets no `selenium-url`.
   *  Config (per tenant) takes precedence; this keeps the extension runnable
   *  with only env (no config seeded). */
  target: BrowserTarget
  /** Per-context viewport; null uses the browser default. */
  viewport: { width: number; height: number } | null
  ignoreHttpsErrors: boolean
  /** Close a context after this many ms idle (0 disables). */
  idleTimeoutMs: number
  /** Hard cap on live contexts (LRU-evicts an idle one when exceeded). */
  maxContexts: number
  /** Default per-action timeout. */
  defaultTimeoutMs: number
  /** File-ingest/get deps. Defaults to the agent file RPCs (needs a bus). */
  deps?: PlaywrightDeps
  /** Read the effective extension config (session > global > default) for a
   *  tenant. When provided, `selenium-url` overrides the env target per call. */
  getConfig?: (name: string, sessionName?: string, tenant?: string) => unknown
}

/** Config knob holding the Selenium WebDriver base URL. When set for a tenant
 *  it overrides the extension's boot-time env target. */
export const CONFIG_SELENIUM_URL = 'selenium-url'

export interface PlaywrightExtensionBundle {
  config: ExtensionConfig
  manager: ContextManager
  stop: () => Promise<void>
}

/**
 * Build the playwright extension over a bus. The bus is used only for the
 * agent file RPCs (screenshots/uploads); browser traffic goes over CDP.
 *
 * A single `context_id` key is minted by `browser-create-context`; every other
 * tool requires it. Contexts are scoped to the calling (tenant, session) and
 * are reaped when idle or when the session is deleted.
 */
export function createPlaywrightExtension(
  bus: import('@abc-protocol/sdk').Bus,
  opts: PlaywrightExtensionOpts,
): PlaywrightExtensionBundle {
  const deps = opts.deps ?? agentFileDeps(bus)

  // The browser target is resolved PER CALL: a tenant's `selenium-url` config
  // overrides the boot-time env target. Factories are cached by base URL so
  // repeated contexts share one Selenium attachment pool.
  const seleniumFactories = new Map<string, SeleniumBrowserFactory>()
  const cdpFactory =
    opts.target.kind === 'cdp'
      ? new CdpBrowserFactory({
          endpoint: opts.target.endpoint,
          viewport: opts.viewport,
          ignoreHttpsErrors: opts.ignoreHttpsErrors,
        })
      : null

  /** Resolve the Selenium base URL for a scope: config first, then env. */
  const seleniumUrlFor = (tenant: string, session: string): string => {
    const cfg = opts.getConfig?.(CONFIG_SELENIUM_URL, session, tenant)
    const s = typeof cfg === 'string' ? cfg.trim() : ''
    if (s !== '') return s
    return opts.target.kind === 'selenium' ? opts.target.baseUrl : ''
  }

  /** A (cached) Selenium factory for one base URL. */
  const seleniumFactoryFor = (baseUrl: string): SeleniumBrowserFactory => {
    let f = seleniumFactories.get(baseUrl)
    if (f === undefined) {
      f = new SeleniumBrowserFactory({
        baseUrl,
        browserName:
          opts.target.kind === 'selenium' ? opts.target.browserName : 'chrome',
        viewport: opts.viewport,
        ignoreHttpsErrors: opts.ignoreHttpsErrors,
        cdpTimeoutMs:
          opts.target.kind === 'selenium' ? opts.target.cdpTimeoutMs : 30_000,
      })
      seleniumFactories.set(baseUrl, f)
    }
    return f
  }

  // Per-context log stores, keyed by context_id (the manager owns the context
  // lifecycle; logs live alongside it).
  const logsByContext = new Map<string, ContextLogs>()

  const managerOpts: ContextManagerOpts = {
    idleTimeoutMs: opts.idleTimeoutMs,
    maxContexts: opts.maxContexts,
    createBrowser: async (tenant, session) => {
      const seleniumUrl = seleniumUrlFor(tenant, session)
      if (seleniumUrl !== '') {
        const factory = seleniumFactoryFor(seleniumUrl)
        const s = await factory.create()
        return {
          browser: s.browser,
          context: s.page.context(),
          page: s.page,
          driverSessionId: s.sessionId,
          // Bind teardown to the SAME factory instance that created it, so a
          // later config change cannot orphan this WebDriver session.
          releaseDriver: () =>
            factory.deleteSession(s.sessionId).catch(() => {}),
        }
      }
      if (cdpFactory !== null) {
        const { browser, page } = await cdpFactory.create()
        return {
          browser,
          context: page.context(),
          page,
          driverSessionId: null,
        }
      }
      throw new Error('no browser target configured')
    },
    destroyBrowser: async (s: BrowserSession) => {
      logsByContext.delete(s.contextId)
      if (s.releaseDriver !== undefined) {
        // The WebDriver session owns the browser; deleting it closes the
        // context+pages and frees the Grid slot. Disconnect CDP after.
        await s.releaseDriver()
        await s.browser.close().catch(() => {})
      } else {
        await s.page
          .context()
          .close()
          .catch(() => {})
      }
    },
    onError: () => {},
  }
  const manager = new ContextManager(managerOpts)
  manager.start()

  const tools = pwTools()
  const specs: Record<string, ToolSpec> = {}

  const toolCtx = (session: BrowserSession, locale: string): ToolCtx => {
    let logs = logsByContext.get(session.contextId)
    if (logs === undefined) {
      logs = newContextLogs()
      logsByContext.set(session.contextId, logs)
    }
    return {
      manager,
      deps,
      logs,
      defaultTimeoutMs: opts.defaultTimeoutMs,
      locale,
    }
  }

  for (const [name, tool] of Object.entries(tools)) {
    if (name === 'browser-create-context' || name === 'browser-close-context') {
      continue
    }
    specs[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      // Marking the knob required makes the agent SURFACE it in the UI
      // (withExtConfig only attaches declared config that a tool requires) and
      // gate the tool until set. The chart seeds it for every tenant, so the
      // tools work out of the box; a UI-set value overrides the seed.
      requiredConfig: [CONFIG_SELENIUM_URL],
      execute: async (args, _callId, sessionName, _signal, tenant) => {
        const t = tenant ?? ''
        const locale = await localeOf(deps, t, sessionName ?? '')
        const contextId = String(args['context_id'] ?? '')
        if (contextId === '') {
          throw new Error(tr(locale, 'contextIdRequired'))
        }
        const result = await manager.withContext(
          contextId,
          t,
          sessionName,
          async session => {
            const ctx = toolCtx(session, locale)
            const clean = { ...args }
            delete clean['context_id']
            return tool.exec(ctx, session, clean)
          },
        )
        return {
          content: result.content,
          ...(result.data !== undefined ? { data: result.data } : {}),
        }
      },
    }
  }

  // browser-create-context is special: it mints the key and returns it.
  const createTool = tools['browser-create-context']
  specs['browser-create-context'] = {
    description: createTool?.description ?? 'Create a browser context',
    inputSchema: { type: 'object', properties: {} },
    requiredConfig: [CONFIG_SELENIUM_URL],
    execute: async (_args, _callId, sessionName, _signal, tenant) => {
      const locale = await localeOf(deps, tenant ?? '', sessionName ?? '')
      const contextId = await manager.create(tenant ?? '', sessionName ?? '')
      // Attach logging to the new page.
      const session = manager.get(contextId, tenant ?? '', sessionName ?? '')
      const logs = newContextLogs()
      logsByContext.set(contextId, logs)
      wirePageLogging(session.page, logs)
      return {
        content: tr(locale, 'createdContext', { id: contextId }),
        data: { context_id: contextId },
      }
    },
  }

  // browser-close-context closes one context by id, or every context of the
  // session when `all: true`.
  const closeTool = tools['browser-close-context']
  specs['browser-close-context'] = {
    description: closeTool?.description ?? 'Close a browser context',
    inputSchema: closeTool?.inputSchema ?? { type: 'object', properties: {} },
    execute: async (args, _callId, sessionName, _signal, tenant) => {
      const t = tenant ?? ''
      const locale = await localeOf(deps, t, sessionName ?? '')
      if (args['all'] === true) {
        const n = await manager.closeSession(t, sessionName ?? '')
        return { content: tr(locale, 'closedContexts', { n }) }
      }
      const contextId = String(args['context_id'] ?? '')
      if (contextId === '') {
        throw new Error(tr(locale, 'contextIdRequiredUnlessAll'))
      }
      await manager.close(contextId, t, sessionName ?? '')
      logsByContext.delete(contextId)
      return { content: tr(locale, 'closedContext', { id: contextId }) }
    },
  }

  const config: ExtensionConfig = {
    id: 'playwright',
    version: '0.1.0',
    tools: specs,
    config: {
      [CONFIG_SELENIUM_URL]: {
        type: 'string',
        default: '',
        scope: 'global',
        description:
          'Selenium WebDriver base URL the browser tools drive (e.g. http://selenium:4444). Overrides the extension env target when set.',
        descriptions: {
          zh: '浏览器工具所驱动的 Selenium WebDriver 基础地址（如 http://selenium:4444）。设置后覆盖扩展的环境变量目标。',
        },
      },
    },
    lifecycle: ['deleted'],
    onLifecycle: async (ev, tenant) => {
      if (ev.kind !== 'deleted') return
      // Close every browser context the deleted session owns (its context_id
      // keys become invalid immediately).
      await manager.closeSession(tenant ?? '', ev.session_name)
    },
  }

  return {
    config,
    manager,
    stop: async () => {
      await manager.stop()
      await cdpFactory?.disconnect()
    },
  }
}
