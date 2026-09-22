import { tr } from '../i18n.js'
import type { Exec } from './shared.js'
import { boolArg, numArg, render, strArg } from './shared.js'

/**
 * Observability tools over the extension's per-context captured telemetry
 * (console + network logs) — historical data `page.*` cannot express.
 */

function isStatic(r: { resourceType: string; status: number }): boolean {
  const staticTypes = new Set([
    'image',
    'font',
    'stylesheet',
    'script',
    'media',
  ])
  return staticTypes.has(r.resourceType) && r.status < 400
}

export function observabilityTools(): Record<string, Exec> {
  const consoleMessages: Exec = async (ctx, _session, args) => {
    const logs = ctx.logs
    const level = strArg(args, 'level') || 'info'
    const order = ['error', 'warning', 'info', 'debug']
    const min = order.indexOf(level)
    const start = boolArg(args, 'all') === true ? 0 : logs.navMark
    const filtered = logs.console
      .slice(start)
      .filter(m => order.indexOf(m.type) <= min)
    return {
      content:
        filtered.length === 0
          ? tr(ctx.locale ?? 'en', 'noConsoleMessages')
          : filtered
              .map(m => `[${m.type}] ${m.text} (${m.location})`)
              .join('\n'),
    }
  }

  const networkRequests: Exec = async (ctx, _session, args) => {
    const includeStatic = boolArg(args, 'static') ?? false
    const filterRaw = strArg(args, 'filter')
    const filter = filterRaw !== '' ? new RegExp(filterRaw) : null
    const rows = ctx.logs.requests.filter(
      r =>
        (includeStatic || !isStatic(r)) &&
        (filter === null || filter.test(r.url)),
    )
    return {
      content:
        rows.length === 0
          ? tr(ctx.locale ?? 'en', 'noNetworkRequests')
          : rows
              .map((r, i) => `${i + 1}. ${r.method} ${r.url} -> ${r.status}`)
              .join('\n'),
    }
  }

  const networkRequest: Exec = async (ctx, _session, args) => {
    const index = numArg(args, 'index') ?? 0
    const rows = ctx.logs.requests.filter(r => !isStatic(r))
    const rec = rows[index - 1]
    if (rec === undefined)
      throw new Error(tr(ctx.locale ?? 'en', 'noRequestAtIndex', { index }))
    const part = strArg(args, 'part')
    if (part === 'request-headers')
      return { content: render(rec.requestHeaders) }
    if (part === 'response-headers')
      return { content: render(rec.responseHeaders) }
    return { content: render(rec) }
  }

  return {
    'browser-console-messages': consoleMessages,
    'browser-network-requests': networkRequests,
    'browser-network-request': networkRequest,
  }
}
