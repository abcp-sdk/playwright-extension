import type { ConsoleMessage, Page, Request } from 'playwright-core'
import type { ToolSpec } from '@abc-protocol/sdk'
import type { PlaywrightDeps } from '../deps.js'
import { tr } from '../i18n.js'
import type { ContextManager, BrowserSession } from '../context-manager.js'
import {
  boolArg,
  captureSnapshot,
  numArg,
  render,
  requireArg,
  resolveLocator,
  strArg,
  strArray,
} from './shared.js'

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
type Exec = (
  ctx: ToolCtx,
  session: BrowserSession,
  args: Record<string, unknown>,
) => Promise<{ content: string; data?: unknown }>

export interface PwTool {
  description: string
  inputSchema: Record<string, unknown>
  exec: Exec
}

const CONTEXT_PROP = {
  context_id: {
    type: 'string',
    description:
      'The browser context key returned by browser-create-context. Required: browser sessions are created explicitly and reused across calls.',
  },
} as const

const TARGET_PROP = {
  target: {
    type: 'string',
    description:
      'Exact target element reference from the page snapshot (e.g. "e12"), or a Playwright selector.',
  },
} as const

const ELEMENT_PROP = {
  element: {
    type: 'string',
    description: 'Human-readable element description (for the interaction log).',
  },
} as const

function schema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: { ...CONTEXT_PROP, ...properties },
    required: ['context_id', ...required],
  }
}

/** Strip the context_id (consumed by the router) from the args. */
export function argsWithoutContext(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { context_id: _ignored, ...rest } = args
  return rest
}

/**
 * The full tool set (28). Everything the model can do on a page lives here;
 * thin wrappers that only forward to `page.*` (coordinates, verify*, storage
 * get/set, routes, media emulation) are intentionally NOT tools — the model
 * uses browser-run-code-unsafe for those. What remains are the commonly used
 * interactions plus the operations that CANNOT be expressed as `page.*`
 * (agent file ingest for produced files, historical logs, tab/session
 * lifecycle).
 */
export function pwTools(): Record<string, PwTool> {
  const ctxCreate: PwTool = {
    description:
      'Create a new browser context and return its context_id. Every other browser tool requires this context_id, and the context (cookies, storage, tabs) persists across calls until browser-close-context, an idle timeout, or the session is deleted.',
    inputSchema: { type: 'object', properties: {} },
    exec: async () => {
      throw new Error('browser-create-context is handled by the router')
    },
  }

  const ctxClose: PwTool = {
    description:
      'Close a browser context (or all of them). Pass context_id to close one context; pass all=true to close every context of this session. Closing a context releases its browser (WebDriver session).',
    inputSchema: {
      type: 'object',
      properties: {
        context_id: {
          type: 'string',
          description: 'The context to close. Ignored when all=true.',
        },
        all: {
          type: 'boolean',
          description: 'Close every context of this session instead of one.',
        },
      },
      required: [],
    },
    exec: async () => {
      throw new Error('browser-close-context is handled by the router')
    },
  }

  const navigate: PwTool = {
    description: 'Navigate to a URL',
    inputSchema: schema(
      { url: { type: 'string', description: 'The URL to navigate to' } },
      ['url'],
    ),
    exec: async (ctx, session, args) => {
      const url = requireArg(args, 'url')
      await session.page.goto(url, { waitUntil: 'domcontentloaded' })
      return { content: tr(ctx.locale ?? 'en', 'navigated', { url }) }
    },
  }

  const navigateBack: PwTool = {
    description: 'Go back to the previous page in the history',
    inputSchema: schema({}, []),
    exec: async (ctx, session) => {
      await session.page.goBack({ waitUntil: 'domcontentloaded' })
      return { content: tr(ctx.locale ?? 'en', 'wentBack', { url: session.page.url() }) }
    },
  }

  const snapshot: PwTool = {
    description:
      'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: schema(
      {
        target: TARGET_PROP.target,
        depth: { type: 'number', description: 'Limit the depth of the snapshot tree' },
        boxes: {
          type: 'boolean',
          description: 'Include each element bounding box as [box=x,y,width,height]',
        },
      },
      [],
    ),
    exec: async (_ctx, session, args) => {
      const target = strArg(args, 'target')
      const depth = numArg(args, 'depth')
      const boxes = boolArg(args, 'boxes')
      const text = await captureSnapshot(session.page, {
        ...(target !== '' ? { target } : {}),
        ...(depth !== undefined ? { depth } : {}),
        ...(boxes !== undefined ? { boxes } : {}),
      })
      return { content: text }
    },
  }

  const click: PwTool = {
    description: 'Perform click on a web page',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        doubleClick: { type: 'boolean', description: 'Perform a double click' },
        button: { type: 'string', description: 'Button to click, defaults to left' },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys',
        },
      },
      ['target'],
    ),
    exec: async (ctx, session, args) => {
      const target = requireArg(args, 'target')
      const loc = resolveLocator(session.page, target)
      const dbl = boolArg(args, 'doubleClick') ?? false
      const button = (strArg(args, 'button') || 'left') as 'left' | 'right' | 'middle'
      const modifiers = strArray(args, 'modifiers') as Array<
        'Alt' | 'Control' | 'Meta' | 'Shift'
      >
      await loc.click({
        ...(dbl ? { clickCount: 2 } : {}),
        button,
        ...(modifiers.length > 0 ? { modifiers } : {}),
      })
      return { content: tr(ctx.locale ?? 'en', 'clicked', { target: strArg(args, 'element') || target }) }
    },
  }

  const type: PwTool = {
    description: 'Type text into editable element',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        text: { type: 'string', description: 'Text to type into the element' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        slowly: { type: 'boolean', description: 'Type one character at a time' },
      },
      ['target', 'text'],
    ),
    exec: async (ctx, session, args) => {
      const target = requireArg(args, 'target')
      const text = requireArg(args, 'text')
      const loc = resolveLocator(session.page, target)
      if (boolArg(args, 'slowly') === true) {
        await loc.pressSequentially(text)
      } else {
        await loc.fill(text)
      }
      if (boolArg(args, 'submit') === true) await loc.press('Enter')
      return { content: tr(ctx.locale ?? 'en', 'typed', { target: strArg(args, 'element') || target }) }
    },
  }

  const hover: PwTool = {
    description: 'Hover over element on page',
    inputSchema: schema(
      { element: ELEMENT_PROP.element, target: TARGET_PROP.target },
      ['target'],
    ),
    exec: async (ctx, session, args) => {
      const target = requireArg(args, 'target')
      await resolveLocator(session.page, target).hover()
      return { content: tr(ctx.locale ?? 'en', 'hovered', { target: strArg(args, 'element') || target }) }
    },
  }

  const selectOption: PwTool = {
    description: 'Select an option in a dropdown',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Values to select',
        },
      },
      ['target', 'values'],
    ),
    exec: async (ctx, session, args) => {
      const target = requireArg(args, 'target')
      const values = strArray(args, 'values')
      await resolveLocator(session.page, target).selectOption(values)
      return { content: tr(ctx.locale ?? 'en', 'selected', { values: values.join(', ') }) }
    },
  }

  const pressKey: PwTool = {
    description: 'Press a key on the keyboard',
    inputSchema: schema(
      { key: { type: 'string', description: 'Name of the key or a character' } },
      ['key'],
    ),
    exec: async (ctx, session, args) => {
      const key = requireArg(args, 'key')
      await session.page.keyboard.press(key)
      return { content: tr(ctx.locale ?? 'en', 'pressed', { key }) }
    },
  }

  const waitFor: PwTool = {
    description: 'Wait for text to appear or disappear or a specified time to pass',
    inputSchema: schema(
      {
        time: { type: 'number', description: 'The time to wait in seconds' },
        text: { type: 'string', description: 'The text to wait for' },
        textGone: { type: 'string', description: 'The text to wait to disappear' },
      },
      [],
    ),
    exec: async (ctx, session, args) => {
      const time = numArg(args, 'time')
      const text = strArg(args, 'text')
      const textGone = strArg(args, 'textGone')
      if (time !== undefined) await session.page.waitForTimeout(time * 1000)
      if (text !== '') {
        await session.page.getByText(text).first().waitFor({ state: 'visible' })
      }
      if (textGone !== '') {
        await session.page.getByText(textGone).first().waitFor({ state: 'hidden' })
      }
      return { content: tr(ctx.locale ?? 'en', 'waitCompleted') }
    },
  }

  const resize: PwTool = {
    description: 'Resize browser window',
    inputSchema: schema(
      {
        width: { type: 'number', description: 'Viewport width' },
        height: { type: 'number', description: 'Viewport height' },
      },
      ['width', 'height'],
    ),
    exec: async (ctx, session, args) => {
      const width = numArg(args, 'width') ?? 0
      const height = numArg(args, 'height') ?? 0
      await session.page.setViewportSize({ width, height })
      return { content: tr(ctx.locale ?? 'en', 'resized', { w: width, h: height }) }
    },
  }

  const tabs: PwTool = {
    description: 'List, create, close, or select a browser tab.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
        index: { type: 'number', description: 'Tab index for close/select' },
        url: { type: 'string', description: 'URL for the new tab' },
      },
      ['action'],
    ),
    exec: async (ctx, session, args) => {
      const action = requireArg(args, 'action')
      const context = session.context
      const pages = context.pages()
      switch (action) {
        case 'list':
          return {
            content: render(
              pages.map((p, i) => ({ index: i, url: p.url(), title: '' })),
            ),
          }
        case 'new': {
          const p = await context.newPage()
          const url = strArg(args, 'url')
          if (url !== '') await p.goto(url, { waitUntil: 'domcontentloaded' })
          session.page = p
          return { content: tr(ctx.locale ?? 'en', 'openedTab', { index: context.pages().length - 1 }) }
        }
        case 'select': {
          const idx = numArg(args, 'index')
          if (idx === undefined || idx < 0 || idx >= pages.length) {
            throw new Error(tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: String(idx) }))
          }
          const p = pages[idx]
          if (p === undefined) throw new Error(tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: idx }))
          await p.bringToFront()
          session.page = p
          return { content: tr(ctx.locale ?? 'en', 'selectedTab', { index: idx }) }
        }
        case 'close': {
          const idx = numArg(args, 'index')
          const p = idx === undefined ? session.page : pages[idx]
          if (p === undefined) throw new Error(tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: String(idx) }))
          await p.close()
          const first = context.pages()[0]
          if (first !== undefined) session.page = first
          return { content: tr(ctx.locale ?? 'en', 'closedTab') }
        }
        default:
          throw new Error(tr(ctx.locale ?? 'en', 'unknownTabsAction', { action }))
      }
    },
  }

  const drag: PwTool = {
    description: 'Perform drag and drop between two elements',
    inputSchema: schema(
      {
        startElement: { type: 'string' },
        startTarget: TARGET_PROP.target,
        endElement: { type: 'string' },
        endTarget: TARGET_PROP.target,
      },
      ['startTarget', 'endTarget'],
    ),
    exec: async (ctx, session, args) => {
      const start = resolveLocator(session.page, requireArg(args, 'startTarget'))
      const end = resolveLocator(session.page, requireArg(args, 'endTarget'))
      await start.dragTo(end)
      return { content: tr(ctx.locale ?? 'en', 'dragged') }
    },
  }

  const fillForm: PwTool = {
    description: 'Fill multiple form fields',
    inputSchema: schema(
      {
        fields: {
          type: 'array',
          description: 'Fields to fill in',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              target: { type: 'string' },
              type: {
                type: 'string',
                enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'],
              },
              value: { type: 'string' },
            },
            required: ['name', 'target', 'type', 'value'],
          },
        },
      },
      ['fields'],
    ),
    exec: async (ctx, session, args) => {
      const fields = Array.isArray(args['fields']) ? args['fields'] : []
      const done: string[] = []
      for (const f of fields as Array<Record<string, unknown>>) {
        const target = String(f['target'] ?? '')
        const value = String(f['value'] ?? '')
        const kind = String(f['type'] ?? 'textbox')
        const loc = resolveLocator(session.page, target)
        if (kind === 'checkbox' || kind === 'radio') {
          if (value === 'true') await loc.check()
          else await loc.uncheck()
        } else if (kind === 'combobox') {
          await loc.selectOption(value)
        } else {
          await loc.fill(value)
        }
        done.push(`${String(f['name'] ?? target)}=${value}`)
      }
      return { content: tr(ctx.locale ?? 'en', 'filled', { fields: done.join(', ') }) }
    },
  }

  const handleDialog: PwTool = {
    description:
      'Handle the next JavaScript dialog (alert/confirm/prompt): accept or dismiss it.',
    inputSchema: schema(
      {
        accept: { type: 'boolean', description: 'Whether to accept the dialog' },
        promptText: { type: 'string', description: 'Prompt text' },
      },
      ['accept'],
    ),
    exec: async (ctx, session, args) => {
      const accept = boolArg(args, 'accept') ?? true
      const promptText = strArg(args, 'promptText')
      session.page.once('dialog', d => {
        const action = accept
          ? d.accept(promptText !== '' ? promptText : undefined)
          : d.dismiss()
        void action.catch(() => {})
      })
      return {
        content: tr(ctx.locale ?? 'en', 'nextDialog', {
          state: accept
            ? tr(ctx.locale ?? 'en', 'dialogAccepted')
            : tr(ctx.locale ?? 'en', 'dialogDismissed'),
        }),
      }
    },
  }

  const evaluate: PwTool = {
    description: 'Evaluate JavaScript expression on page or element',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        function: {
          type: 'string',
          description: '() => { /* code */ } or (element) => { /* code */ }',
        },
      },
      ['function'],
    ),
    exec: async (_ctx, session, args) => {
      const fn = requireArg(args, 'function')
      const target = strArg(args, 'target')
      // `page.evaluate("() => {...}")` would treat the string as an EXPRESSION
      // (evaluating to a function object that is never called). Wrap it so the
      // user's function is actually INVOKED with the page (or the element).
      const pageFn = new Function('arg', `return (${fn})(arg)`)
      const elemFn = new Function('el', 'arg', `return (${fn})(el, arg)`)
      const result =
        target !== ''
          ? await resolveLocator(session.page, target).evaluate(elemFn as never)
          : await session.page.evaluate(pageFn as never)
      return { content: render(result) }
    },
  }

  const runCodeUnsafe: PwTool = {
    description:
      'Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent. Use it for anything the dedicated tools do not cover (coordinates, routes, storage, media emulation, assertions).',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          description: 'A JavaScript function receiving `page` as its single argument',
        },
      },
      ['code'],
    ),
    exec: async (_ctx, session, args) => {
      const code = requireArg(args, 'code')
      const AsyncFunction = Object.getPrototypeOf(async () => {})
        .constructor as new (...a: string[]) => (page: Page) => Promise<unknown>
      const fn = new AsyncFunction('page', `return (${code})(page)`)
      const result = await fn(session.page)
      return { content: render(result) }
    },
  }

  const find: PwTool = {
    description:
      'Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot lines.',
    inputSchema: schema(
      {
        text: { type: 'string', description: 'Plain text to search for' },
        regex: { type: 'string', description: 'Regular expression to search for' },
      },
      [],
    ),
    exec: async (ctx, session, args) => {
      const snap = await captureSnapshot(session.page)
      const text = strArg(args, 'text')
      const regexRaw = strArg(args, 'regex')
      let matcher: (line: string) => boolean
      if (text !== '') {
        const needle = text.toLowerCase()
        matcher = l => l.toLowerCase().includes(needle)
      } else if (regexRaw !== '') {
        const re = parseSlashRegex(regexRaw)
        matcher = l => re.test(l)
      } else {
        throw new Error(tr(ctx.locale ?? 'en', 'provideTextOrRegex'))
      }
      const hits = snap.split('\n').filter(matcher)
      return {
        content: hits.length === 0 ? tr(ctx.locale ?? 'en', 'noMatches') : hits.join('\n'),
      }
    },
  }

  // ---- observability (historical logs; not expressible via page.*) ----

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
          description: 'Include successful static resources. Defaults to false.',
        },
        filter: { type: 'string', description: 'Only URLs matching this regexp' },
      },
      [],
    ),
    exec: async (ctx, _session, args) => {
      const includeStatic = boolArg(args, 'static') ?? false
      const filterRaw = strArg(args, 'filter')
      const filter = filterRaw !== '' ? new RegExp(filterRaw) : null
      const rows = ctx.logs.requests.filter(
        r => (includeStatic || !isStatic(r)) && (filter === null || filter.test(r.url)),
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
      if (rec === undefined) throw new Error(tr(ctx.locale ?? 'en', 'noRequestAtIndex', { index }))
      const part = strArg(args, 'part')
      if (part === 'request-headers') return { content: render(rec.requestHeaders) }
      if (part === 'response-headers') return { content: render(rec.responseHeaders) }
      return { content: render(rec) }
    },
  }

  // ---- file-producing tools (need the agent ingest; not expressible as page.*) ----

  const takeScreenshot: PwTool = {
    description:
      'Take a screenshot of the current page. The image is stored and returned as a file:<code> reference (like image generation); use browser-snapshot for actions.',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        type: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: 'Image format',
        },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
      },
      [],
    ),
    exec: async (ctx, session, args) => {
      const target = strArg(args, 'target')
      const fullPage = boolArg(args, 'fullPage') ?? false
      const type = (strArg(args, 'type') || 'png') as 'png' | 'jpeg' | 'webp'
      const opts = { type } as const
      const buf =
        target !== ''
          ? await resolveLocator(session.page, target).screenshot(opts)
          : await session.page.screenshot({ ...opts, fullPage })
      const file = await ingest(ctx, session, buf, `screenshot-${Date.now()}.${type}`)
      return {
        content: tr(ctx.locale ?? 'en', 'screenshotSaved', {
          code: file.code,
          mime: file.mime,
          bytes: buf.length,
        }),
        data: { files: [file] },
      }
    },
  }

  const pdfSave: PwTool = {
    description:
      'Save the page as a PDF (headless Chromium only). The PDF is stored and returned as a file:<code> reference.',
    inputSchema: schema(
      {
        format: {
          type: 'string',
          description: 'Paper format, e.g. A4, Letter (default: browser default).',
        },
        landscape: { type: 'boolean', description: 'Landscape orientation' },
        printBackground: {
          type: 'boolean',
          description: 'Print background graphics (default false)',
        },
      },
      [],
    ),
    exec: async (ctx, session, args) => {
      const format = strArg(args, 'format')
      const landscape = boolArg(args, 'landscape')
      const printBackground = boolArg(args, 'printBackground')
      const buf = await session.page
        .pdf({
          ...(format !== '' ? { format } : {}),
          ...(landscape !== undefined ? { landscape } : {}),
          ...(printBackground !== undefined ? { printBackground } : {}),
        })
        .catch(e => {
          throw new Error(
            tr(ctx.locale ?? 'en', 'pdfHeadlessOnly', {
              detail: e instanceof Error ? e.message : String(e),
            }),
          )
        })
      const file = await ingest(ctx, session, buf, `page-${Date.now()}.pdf`)
      return {
        content: tr(ctx.locale ?? 'en', 'pdfSaved', {
          code: file.code,
          mime: file.mime,
          bytes: buf.length,
        }),
        data: { files: [file] },
      }
    },
  }

  const fileUpload: PwTool = {
    description:
      'Upload one or more stored files (referenced as file:<code>) to the page file chooser / first file input.',
    inputSchema: schema(
      {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'File codes (the 16-char segment after file:) to upload',
        },
      },
      ['codes'],
    ),
    exec: async (ctx, session, args) => {
      const codes = strArray(args, 'codes')
      if (codes.length === 0) throw new Error(tr(ctx.locale ?? 'en', 'codesRequired'))
      const files: Array<{ name: string; mimeType: string; buffer: Buffer }> = []
      for (const code of codes) {
        const got = await ctx.deps.getFile(code, session.tenant)
        files.push({
          name: got.name || `${code}.bin`,
          mimeType: got.mime || 'application/octet-stream',
          buffer: Buffer.from(got.data),
        })
      }
      const input = session.page.locator('input[type=file]').first()
      await input.setInputFiles(files)
      return { content: tr(ctx.locale ?? 'en', 'uploadedFiles', { n: files.length }) }
    },
  }

  const drop: PwTool = {
    description:
      'Drop MIME-typed data (or stored files referenced as file:<code>) onto an element. Provide data (mime -> string) and/or codes.',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        data: {
          type: 'object',
          description: 'MIME type -> string value, e.g. {"text/plain":"hello"}',
        },
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Stored file codes to drop as files',
        },
      },
      ['target'],
    ),
    exec: async (ctx, session, args) => {
      const target = requireArg(args, 'target')
      const data = (args['data'] ?? {}) as Record<string, string>
      const codes = strArray(args, 'codes')
      const files: Array<{ name: string; mime: string; b64: string }> = []
      for (const code of codes) {
        const got = await ctx.deps.getFile(code, session.tenant)
        files.push({
          name: got.name || `${code}.bin`,
          mime: got.mime || 'application/octet-stream',
          b64: Buffer.from(got.data).toString('base64'),
        })
      }
      const locator = resolveLocator(session.page, target)
      const handle = await session.page.evaluateHandle(
        (payload: { data: Record<string, string>; files: typeof files }) => {
          const dt = new DataTransfer()
          for (const [mime, value] of Object.entries(payload.data)) {
            dt.setData(mime, value)
          }
          for (const f of payload.files) {
            const bin = atob(f.b64)
            const bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            dt.items.add(new File([bytes], f.name, { type: f.mime }))
          }
          return dt
        },
        { data, files },
      )
      await locator.dispatchEvent('drop', { dataTransfer: handle })
      return { content: tr(ctx.locale ?? 'en', 'dropped', { target: strArg(args, 'element') || target }) }
    },
  }

  const storageState: PwTool = {
    description:
      'Export the context storage state (cookies + localStorage) as a file:<code> JSON reference.',
    inputSchema: schema({}, []),
    exec: async (ctx, session) => {
      const state = await session.context.storageState()
      const buf = Buffer.from(JSON.stringify(state))
      const file = await ingest(
        ctx,
        session,
        buf,
        `storage-state-${Date.now()}.json`,
      )
      return {
        content: tr(ctx.locale ?? 'en', 'storageStateSaved', {
          code: file.code,
          bytes: buf.length,
        }),
        data: { files: [file] },
      }
    },
  }

  const setStorageState: PwTool = {
    description:
      'Restore context storage state from a stored JSON file (file:<code>) produced by browser-storage-state. Adds the cookies and localStorage.',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          description: 'The file code (after file:) of the storage state JSON',
        },
      },
      ['code'],
    ),
    exec: async (ctx, session, args) => {
      const code = requireArg(args, 'code')
      const got = await ctx.deps.getFile(code, session.tenant)
      const parsed = JSON.parse(Buffer.from(got.data).toString()) as {
        cookies?: Parameters<typeof session.context.addCookies>[0]
        origins?: Array<{
          origin: string
          localStorage?: Array<{ name: string; value: string }>
        }>
      }
      if (Array.isArray(parsed.cookies) && parsed.cookies.length > 0) {
        await session.context.addCookies(parsed.cookies)
      }
      for (const o of parsed.origins ?? []) {
        const page = await session.context.newPage()
        try {
          await page.goto(o.origin, { waitUntil: 'domcontentloaded' })
          await page.evaluate((items: Array<{ name: string; value: string }>) => {
            for (const it of items) localStorage.setItem(it.name, it.value)
          }, o.localStorage ?? [])
        } finally {
          await page.close()
        }
      }
      return { content: tr(ctx.locale ?? 'en', 'storageStateRestored', { code }) }
    },
  }

  return {
    'browser-create-context': ctxCreate,
    'browser-close-context': ctxClose,
    'browser-navigate': navigate,
    'browser-navigate-back': navigateBack,
    'browser-snapshot': snapshot,
    'browser-find': find,
    'browser-click': click,
    'browser-type': type,
    'browser-hover': hover,
    'browser-select-option': selectOption,
    'browser-press-key': pressKey,
    'browser-wait-for': waitFor,
    'browser-resize': resize,
    'browser-tabs': tabs,
    'browser-drag': drag,
    'browser-fill-form': fillForm,
    'browser-handle-dialog': handleDialog,
    'browser-evaluate': evaluate,
    'browser-console-messages': consoleMessages,
    'browser-network-requests': networkRequests,
    'browser-network-request': networkRequest,
    'browser-take-screenshot': takeScreenshot,
    'browser-pdf-save': pdfSave,
    'browser-file-upload': fileUpload,
    'browser-drop': drop,
    'browser-storage-state': storageState,
    'browser-set-storage-state': setStorageState,
    'browser-run-code-unsafe': runCodeUnsafe,
  }
}

function isStatic(r: { resourceType: string; status: number }): boolean {
  const staticTypes = new Set(['image', 'font', 'stylesheet', 'script', 'media'])
  return staticTypes.has(r.resourceType) && r.status < 400
}

async function ingest(
  ctx: ToolCtx,
  session: BrowserSession,
  buf: Buffer,
  name: string,
): Promise<{ code: string; mime: string; name: string; bytes: number }> {
  const stored = await ctx.deps.ingestFile({
    name,
    data: new Uint8Array(buf),
    session: session.session,
    tenant: session.tenant,
  })
  return { code: stored.code, mime: stored.mime, name, bytes: buf.length }
}

/** Parse `/pattern/flags` or a bare regex into a RegExp. */
function parseSlashRegex(raw: string): RegExp {
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/')
    if (last > 0) {
      return new RegExp(raw.slice(1, last), raw.slice(last + 1))
    }
  }
  return new RegExp(raw)
}
