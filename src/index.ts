import type { ExtensionConfig, ToolSpec } from '@abc-protocol/sdk'
import type { PlaywrightDeps } from './deps.js'
import { agentFileDeps } from './deps.js'
import { CdpBrowserFactory } from './browser.js'
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
export * from './context-manager.js'
export * from './tools/browser.js'

export interface PlaywrightExtensionOpts {
  /** CDP endpoint of the browser to drive (Selenium node / headless Chrome). */
  cdpEndpoint: string
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
 * A single `context_id` key is minted by `browser_create_context`; every other
 * tool requires it. Contexts are scoped to the calling (tenant, session) and
 * are reaped when idle or when the session is deleted.
 */
export function createPlaywrightExtension(
  bus: import('@abc-protocol/sdk').Bus,
  opts: PlaywrightExtensionOpts,
): PlaywrightExtensionBundle {
  const deps = opts.deps ?? agentFileDeps(bus)

  const factory = new CdpBrowserFactory({
    endpoint: opts.cdpEndpoint,
    viewport: opts.viewport,
    ignoreHttpsErrors: opts.ignoreHttpsErrors,
  })

  // Per-context log stores, keyed by context_id (the manager owns the context
  // lifecycle; logs live alongside it).
  const logsByContext = new Map<string, ContextLogs>()

  const managerOpts: ContextManagerOpts = {
    idleTimeoutMs: opts.idleTimeoutMs,
    maxContexts: opts.maxContexts,
    createBrowser: async () => {
      const { browser, page } = await factory.create()
      return {
        browser,
        context: page.context(),
        page,
        driverSessionId: null,
      }
    },
    destroyBrowser: async (s: BrowserSession) => {
      logsByContext.delete(s.contextId)
      await factory.closePage(s.page)
    },
    onError: () => {},
  }
  const manager = new ContextManager(managerOpts)
  manager.start()

  const tools = pwTools()
  const specs: Record<string, ToolSpec> = {}

  const toolCtx = (session: BrowserSession): ToolCtx => {
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
    }
  }

  for (const [name, tool] of Object.entries(tools)) {
    if (name === 'browser_create_context') continue
    specs[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args, _callId, sessionName, _signal, tenant) => {
        const t = tenant ?? ''
        const contextId = String(args['context_id'] ?? '')
        if (contextId === '') {
          throw new Error(
            'context_id is required — call browser_create_context first',
          )
        }
        const result = await manager.withContext(
          contextId,
          t,
          sessionName,
          async session => {
            const ctx = toolCtx(session)
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

  // browser_create_context is special: it mints the key and returns it.
  const createTool = tools['browser_create_context']
  specs['browser_create_context'] = {
    description: createTool?.description ?? 'Create a browser context',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_args, _callId, sessionName, _signal, tenant) => {
      const contextId = await manager.create(tenant ?? '', sessionName ?? '')
      // Attach logging to the new page.
      const session = manager.get(contextId, tenant ?? '', sessionName ?? '')
      const logs = newContextLogs()
      logsByContext.set(contextId, logs)
      wirePageLogging(session.page, logs)
      return {
        content: `Created browser context. context_id: ${contextId}`,
        data: { context_id: contextId },
      }
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
      await factory.disconnect()
    },
  }
}
