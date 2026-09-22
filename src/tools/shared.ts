// Argument-coercion primitives come from the SDK's extension-kit (they used
// to be a per-repo copy that drifted across extensions).
import { strArg } from '@abc-protocol/sdk'
import type { ConsoleMessage, Locator, Page, Request } from 'playwright-core'
import type { BrowserSession, ContextManager } from '../context-manager.js'
import type { PlaywrightDeps } from '../deps.js'

export { boolArg, numArg, strArg, strArray } from '@abc-protocol/sdk'

/**
 * Resolve an official `target` argument to a Playwright Locator. The snapshot
 * emits `[ref=eN]` markers (via `page.ariaSnapshot({mode:'ai'})`), and the
 * `aria-ref` engine resolves them against that last AI snapshot; anything else
 * is treated as a normal Playwright selector.
 */
export function resolveLocator(page: Page, target: string): Locator {
  const t = target.trim()
  if (/^e\d+$/.test(t)) return page.locator(`aria-ref=${t}`)
  return page.locator(t)
}

/**
 * Capture the page accessibility snapshot in AI mode (elements carry `[ref=eN]`
 * so a later `target: "eN"` resolves). This also seeds the `aria-ref` engine.
 */
export async function captureSnapshot(
  page: Page,
  opts: { target?: string; depth?: number; boxes?: boolean } = {},
): Promise<string> {
  const options: {
    mode: 'ai'
    depth?: number
    boxes?: boolean
  } = { mode: 'ai' }
  if (opts.depth !== undefined) options.depth = opts.depth
  if (opts.boxes !== undefined) options.boxes = opts.boxes
  if (opts.target !== undefined && opts.target !== '') {
    return resolveLocator(page, opts.target).ariaSnapshot(options)
  }
  return page.ariaSnapshot(options)
}

/** Format a value for a text tool result (JSON for objects). */
export function render(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function requireArg(args: Record<string, unknown>, key: string): string {
  const v = strArg(args, key)
  if (v === '') throw new Error(`${key} is required`)
  return v
}

/** Everything a tool handler needs at call time. */
export interface ToolCtx {
  manager: ContextManager
  deps: PlaywrightDeps
  /** Per-context console + network logs (kept by the extension, not the page). */
  logs: ContextLogs
  defaultTimeoutMs: number
  /** Session locale for result text ('' => English fallback). */
  locale?: string
}

/**
 * Per-context captured telemetry (console messages + network requests since the
 * context was created). The official server keeps these in-session; we key them
 * by context_id so browser-console-messages / browser-network-requests work.
 */
export interface ContextLogs {
  console: Array<{ type: string; text: string; location: string }>
  /** Console index at the last main-frame navigation (for `all=false`). */
  navMark: number
  requests: Array<{
    method: string
    url: string
    status: number
    resourceType: string
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
  }>
}

export function newContextLogs(): ContextLogs {
  return { console: [], navMark: 0, requests: [] }
}

/** Attach console/network collectors to a fresh page. */
export function wirePageLogging(page: Page, logs: ContextLogs): void {
  page.on('console', (msg: ConsoleMessage) => {
    logs.console.push({
      type: msg.type(),
      text: msg.text(),
      location: `${msg.location().url}:${msg.location().lineNumber}`,
    })
  })
  page.on('request', (req: Request) => {
    logs.requests.push({
      method: req.method(),
      url: req.url(),
      status: 0,
      resourceType: req.resourceType(),
      requestHeaders: req.headers(),
      responseHeaders: {},
    })
  })
  page.on('response', res => {
    const rec = logs.requests.find(r => r.url === res.url() && r.status === 0)
    if (rec !== undefined) {
      rec.status = res.status()
      rec.responseHeaders = res.headers()
    }
  })
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) logs.navMark = logs.console.length
  })
}

/** A tool handler receives the resolved session + raw args (no context_id). */
export type Exec = (
  ctx: ToolCtx,
  session: BrowserSession,
  args: Record<string, unknown>,
) => Promise<{ content: string; data?: unknown }>

/** Parse `/pattern/flags` or a bare regex into a RegExp. */
export function parseSlashRegex(raw: string): RegExp {
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/')
    if (last > 0) {
      return new RegExp(raw.slice(1, last), raw.slice(last + 1))
    }
  }
  return new RegExp(raw)
}
