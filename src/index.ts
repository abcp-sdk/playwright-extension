import type { ExtensionConfig, ToolSpec } from '@abc-protocol/sdk'
import type { PlaywrightDeps } from './deps.js'
import { agentFileDeps } from './deps.js'
import { CdpBrowserFactory } from './browser.js'
import { SeleniumBrowserFactory } from './selenium.js'
import { localeOf, tr } from './i18n.js'
import {
  ContextManager,
  type BrowserSession,
  type ContextManagerOpts,
} from './context-manager.js'
import {
  type ContextLogs,
  newContextLogs,
  pwTools,
  wirePageLogging,
  type ToolCtx,
} from './tools/browser.js'

export * from './deps.js'
export * from './browser.js'
export * from './selenium.js'
export * from './context-manager.js'
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
  /** How to reach the browser. */
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
}

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

  const cdpFactory =
    opts.target.kind === 'cdp'
      ? new CdpBrowserFactory({
          endpoint: opts.target.endpoint,
          viewport: opts.viewport,
          ignoreHttpsErrors: opts.ignoreHttpsErrors,
        })
      : null
  const seleniumFactory =
    opts.target.kind === 'selenium'
      ? new SeleniumBrowserFactory({
          baseUrl: opts.target.baseUrl,
          browserName: opts.target.browserName,
          viewport: opts.viewport,
          ignoreHttpsErrors: opts.ignoreHttpsErrors,
          cdpTimeoutMs: opts.target.cdpTimeoutMs,
        })
      : null

  // Per-context log stores, keyed by context_id (the manager owns the context
  // lifecycle; logs live alongside it).
  const logsByContext = new Map<string, ContextLogs>()

  const managerOpts: ContextManagerOpts = {
    idleTimeoutMs: opts.idleTimeoutMs,
    maxContexts: opts.maxContexts,
    createBrowser: async () => {
      if (seleniumFactory !== null) {
        const s = await seleniumFactory.create()
        return {
          browser: s.browser,
          context: s.page.context(),
          page: s.page,
          driverSessionId: s.sessionId,
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
      if (s.driverSessionId !== null && seleniumFactory !== null) {
        // The WebDriver session owns the browser; deleting it closes the
        // context+pages and frees the Grid slot. Disconnect CDP after.
        await seleniumFactory.deleteSession(s.driverSessionId).catch(() => {})
        await s.browser.close().catch(() => {})
      } else {
        await s.page.context().close().catch(() => {})
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
