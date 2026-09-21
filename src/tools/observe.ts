import { tr } from '../i18n.js'
import {
  boolArg,
  numArg,
  type PwTool,
  render,
  schema,
  strArg,
} from './shared.js'

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

export function observabilityTools(): Record<string, PwTool> {
  const consoleMessages: PwTool = {
    description: 'Returns all console messages',
    inputSchema: schema(
      {
        level: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'debug'],
          description: 'Minimum level to return. Defaults to info.',
        },
        all: {
          type: 'boolean',
          description: 'Return all messages since the context was created',
        },
      },
      [],
    ),
    exec: async (ctx, _session, args) => {
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
    },
  }

  const networkRequests: PwTool = {
    description:
      'Returns a numbered list of network requests since loading the page.',
    inputSchema: schema(
      {
        static: {
          type: 'boolean',
          description:
            'Include successful static resources. Defaults to false.',
        },
        filter: {
          type: 'string',
          description: 'Only URLs matching this regexp',
        },
      },
      [],
    ),
    exec: async (ctx, _session, args) => {
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
    },
  }

  const networkRequest: PwTool = {
    description:
      'Returns full details (headers) of a single network request. Use the number from browser-network-requests.',
    inputSchema: schema(
      {
        index: {
          type: 'number',
          description: '1-based index from browser-network-requests',
        },
        part: {
          type: 'string',
          enum: ['request-headers', 'response-headers'],
        },
      },
      ['index'],
    ),
    exec: async (ctx, _session, args) => {
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
    },
  }

  return {
    'browser-console-messages': consoleMessages,
    'browser-network-requests': networkRequests,
    'browser-network-request': networkRequest,
  }
}
