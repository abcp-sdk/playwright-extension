import type { BrowserContext, ConsoleMessage, Page, Request } from 'playwright-core'
import type { ToolSpec } from '@abc-protocol/sdk'
import type { PlaywrightDeps } from '../deps.js'
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
}

/**
 * Per-context captured telemetry (console messages + network requests since the
 * context was created). The official server keeps these in-session; we key them
 * by context_id so browser_console_messages / browser_network_requests work.
 */
export interface ContextLogs {
  console: Array<{ type: string; text: string; location: string }>
  /** Page load counter used by `all=false` (since last navigation). */
  navMark: number
  requests: Array<{
    method: string
    url: string
    status: number
    resourceType: string
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    body?: string
  }>
  dialogs: Array<{ type: string; message: string }>
}

export function newContextLogs(): ContextLogs {
  return { console: [], navMark: 0, requests: [], dialogs: [] }
}

/** Attach console/network/dialog collectors to a fresh page. */
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
    const rec = logs.requests.find(
      r => r.url === res.url() && r.status === 0,
    )
    if (rec !== undefined) {
      rec.status = res.status()
      rec.responseHeaders = res.headers()
    }
  })
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) logs.navMark = logs.console.length
  })
  page.on('dialog', dialog => {
    logs.dialogs.push({ type: dialog.type(), message: dialog.message() })
  })
}

/** A tool handler receives the resolved session + raw args. */
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

// Every browser tool takes the context_id FIRST so the extension can route to
// the right live browser context; the remaining properties mirror the official
// playwright-mcp schemas.
const CONTEXT_PROP = {
  context_id: {
    type: 'string',
    description:
      'The browser context key returned by browser_create_context. Required: browser sessions are created explicitly and reused across calls.',
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

const SCREENSHOT_SCALE_PROP = {
  scale: {
    type: 'string',
    enum: ['css', 'device'],
    description: 'Screenshot resolution scale. Default is css.',
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
function argsWithoutContext(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { context_id: _ignored, ...rest } = args
  return rest
}

// ---- image helpers ----

async function ingestImage(
  ctx: ToolCtx,
  session: BrowserSession,
  buf: Buffer,
  mime: string,
  name: string,
): Promise<string> {
  const stored = await ctx.deps.ingestFile({
    name,
    mime,
    data: new Uint8Array(buf),
    session: session.session,
    tenant: session.tenant,
  })
  return `file:${stored.code}`
}

// ---- tool definitions ----

export function pwTools(): Record<string, PwTool> {
  const ctxCreate: PwTool = {
    description:
      'Create a new browser context and return its context_id. Every other browser tool requires this context_id, and the context (cookies, storage, tabs) persists across calls until browser_close_context, an idle timeout, or the session is deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CONTEXT_PROP,
      },
      required: [],
    },
    exec: async () => {
      // Handled specially by the router (it mints the key).
      throw new Error('browser_create_context is handled by the router')
    },
  }

  const withLogs = <T>(fn: () => Promise<T>): Promise<T> => fn()
  void withLogs

  const navigate: PwTool = {
    description: 'Navigate to a URL',
    inputSchema: schema({ url: { type: 'string', description: 'The URL to navigate to' } }, ['url']),
    exec: async (ctx, session, args) => {
      const url = requireArg(args, 'url')
      await session.page.goto(url, { waitUntil: 'domcontentloaded' })
      return { content: `Navigated to ${url}` }
    },
  }

  const navigateBack: PwTool = {
    description: 'Go back to the previous page in the history',
    inputSchema: schema({}, []),
    exec: async (_ctx, session) => {
      await session.page.goBack({ waitUntil: 'domcontentloaded' })
      return { content: `Went back to ${session.page.url()}` }
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
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifier keys' },
      },
      ['target'],
    ),
    exec: async (_ctx, session, args) => {
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
      return { content: `Clicked ${strArg(args, 'element') || target}` }
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
    exec: async (_ctx, session, args) => {
      const target = requireArg(args, 'target')
      const text = requireArg(args, 'text')
      const loc = resolveLocator(session.page, target)
      if (boolArg(args, 'slowly') === true) {
        await loc.pressSequentially(text)
      } else {
        await loc.fill(text)
      }
      if (boolArg(args, 'submit') === true) await loc.press('Enter')
      return { content: `Typed into ${strArg(args, 'element') || target}` }
    },
  }

  const hover: PwTool = {
    description: 'Hover over element on page',
    inputSchema: schema(
      { element: ELEMENT_PROP.element, target: TARGET_PROP.target },
      ['target'],
    ),
    exec: async (_ctx, session, args) => {
      const target = requireArg(args, 'target')
      await resolveLocator(session.page, target).hover()
      return { content: `Hovered ${strArg(args, 'element') || target}` }
    },
  }

  const selectOption: PwTool = {
    description: 'Select an option in a dropdown',
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        values: { type: 'array', items: { type: 'string' }, description: 'Values to select' },
      },
      ['target', 'values'],
    ),
    exec: async (_ctx, session, args) => {
      const target = requireArg(args, 'target')
      const values = strArray(args, 'values')
      await resolveLocator(session.page, target).selectOption(values)
      return { content: `Selected ${values.join(', ')}` }
    },
  }

  const takeScreenshot: PwTool = {
    description:
      "Take a screenshot of the current page. The image is stored and returned as a file:<code> reference (like image generation); use browser_snapshot for actions.",
    inputSchema: schema(
      {
        element: ELEMENT_PROP.element,
        target: TARGET_PROP.target,
        type: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
        ...SCREENSHOT_SCALE_PROP,
      },
      [],
    ),
    exec: async (ctx, session, args) => {
      const target = strArg(args, 'target')
      const fullPage = boolArg(args, 'fullPage') ?? false
      const type = (strArg(args, 'type') || 'png') as 'png' | 'jpeg' | 'webp'
      const mime = type === 'png' ? 'image/png' : `image/${type}`
      const opts = { type } as const
      const buf =
        target !== ''
          ? await resolveLocator(session.page, target).screenshot(opts)
          : await session.page.screenshot({ ...opts, fullPage })
      const ref = await ingestImage(
        ctx,
        session,
        buf,
        mime,
        `screenshot-${Date.now()}.${type}`,
      )
      return {
        content: `Screenshot saved as ${ref} (${mime}, ${buf.length} bytes)`,
        data: { file: ref, mime, bytes: buf.length },
      }
    },
  }

  const waitFor: PwTool = {
    description:
      'Wait for text to appear or disappear or a specified time to pass',
    inputSchema: schema(
      {
        time: { type: 'number', description: 'The time to wait in seconds' },
        text: { type: 'string', description: 'The text to wait for' },
        textGone: { type: 'string', description: 'The text to wait to disappear' },
      },
      [],
    ),
    exec: async (_ctx, session, args) => {
      const time = numArg(args, 'time')
      const text = strArg(args, 'text')
      const textGone = strArg(args, 'textGone')
      if (time !== undefined) await session.page.waitForTimeout(time * 1000)
      if (text !== '') await session.page.getByText(text).first().waitFor({ state: 'visible' })
      if (textGone !== '') await session.page.getByText(textGone).first().waitFor({ state: 'hidden' })
      return { content: 'Wait completed' }
    },
  }

  const pressKey: PwTool = {
    description: 'Press a key on the keyboard',
    inputSchema: schema(
      { key: { type: 'string', description: 'Name of the key or a character' } },
      ['key'],
    ),
    exec: async (_ctx, session, args) => {
      const key = requireArg(args, 'key')
      await session.page.keyboard.press(key)
      return { content: `Pressed ${key}` }
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
      const result =
        target !== ''
          ? await resolveLocator(session.page, target).evaluate(fn)
          : await session.page.evaluate(fn)
      return { content: render(result) }
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
    exec: async (_ctx, session, args) => {
      const width = numArg(args, 'width') ?? 0
      const height = numArg(args, 'height') ?? 0
      await session.page.setViewportSize({ width, height })
      return { content: `Resized to ${width}x${height}` }
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
    exec: async (_ctx, session, args) => {
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
          return { content: `Opened tab ${context.pages().length - 1}` }
        }
        case 'select': {
          const idx = numArg(args, 'index')
          if (idx === undefined || idx < 0 || idx >= pages.length) {
            throw new Error(`invalid tab index ${String(idx)}`)
          }
          const p = pages[idx]
          if (p === undefined) throw new Error(`invalid tab index ${idx}`)
          await p.bringToFront()
          session.page = p
          return { content: `Selected tab ${idx}` }
        }
        case 'close': {
          const idx = numArg(args, 'index')
          const p = idx === undefined ? session.page : pages[idx]
          if (p === undefined) throw new Error(`invalid tab index ${String(idx)}`)
          await p.close()
          const remaining = context.pages()
          const first = remaining[0]
          if (first !== undefined) session.page = first
          return { content: 'Closed tab' }
        }
        default:
          throw new Error(`unknown tabs action: ${action}`)
      }
    },
  }

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
    exec: async (ctx, session, args) => {
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
            ? 'No console messages.'
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
      const staticTypes = new Set(['image', 'font', 'stylesheet', 'script', 'media'])
      const rows = ctx.logs.requests.filter(r => {
        if (!includeStatic && staticTypes.has(r.resourceType) && r.status < 400) {
          return false
        }
        if (filter !== null && !filter.test(r.url)) return false
        return true
      })
      return {
        content:
          rows.length === 0
            ? 'No network requests.'
            : rows.map((r, i) => `${i + 1}. ${r.method} ${r.url} -> ${r.status}`).join('\n'),
      }
    },
  }

  const networkRequest: PwTool = {
    description:
      'Returns full details (headers and body) of a single network request.',
    inputSchema: schema(
      {
        index: { type: 'number', description: '1-based index from browser_network_requests' },
        part: {
          type: 'string',
          enum: ['request-headers', 'request-body', 'response-headers', 'response-body'],
        },
      },
      ['index'],
    ),
    exec: async (ctx, _session, args) => {
      const index = numArg(args, 'index') ?? 0
      const includeStatic = false
      const staticTypes = new Set(['image', 'font', 'stylesheet', 'script', 'media'])
      const rows = ctx.logs.requests.filter(
        r => includeStatic || !(staticTypes.has(r.resourceType) && r.status < 400),
      )
      const rec = rows[index - 1]
      if (rec === undefined) throw new Error(`no request at index ${index}`)
      const part = strArg(args, 'part')
      if (part === 'request-headers') return { content: render(rec.requestHeaders) }
      if (part === 'response-headers') return { content: render(rec.responseHeaders) }
      return { content: render(rec) }
    },
  }

  const dialog: PwTool = {
    description: 'Handle a dialog',
    inputSchema: schema(
      {
        accept: { type: 'boolean', description: 'Whether to accept the dialog' },
        promptText: { type: 'string', description: 'Prompt text' },
      },
      ['accept'],
    ),
    exec: async (_ctx, session, args) => {
      // Dialogs are auto-dismissed by Playwright unless a handler is set; the
      // official server records them. We accept/dismiss the NEXT dialog.
      const accept = boolArg(args, 'accept') ?? true
      const promptText = strArg(args, 'promptText')
      session.page.once('dialog', d => {
        void d.accept(promptText !== '' ? promptText : undefined).catch(() => {})
      })
      return { content: `Next dialog will be ${accept ? 'accepted' : 'dismissed'}` }
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
    exec: async (_ctx, session, args) => {
      const start = resolveLocator(session.page, requireArg(args, 'startTarget'))
      const end = resolveLocator(session.page, requireArg(args, 'endTarget'))
      await start.dragTo(end)
      return { content: 'Dragged element' }
    },
  }

  const find: PwTool = {
    description:
      'Search the accessibility snapshot of the current page for text or a regular expression.',
    inputSchema: schema(
      {
        text: { type: 'string', description: 'Plain text to search for' },
        regex: { type: 'string', description: 'Regular expression to search for' },
      },
      [],
    ),
    exec: async (_ctx, session, args) => {
      const snap = await captureSnapshot(session.page)
      const text = strArg(args, 'text')
      const regexRaw = strArg(args, 'regex')
      const lines = snap.split('\n')
      let matcher: (line: string) => boolean
      if (text !== '') {
        const needle = text.toLowerCase()
        matcher = l => l.toLowerCase().includes(needle)
      } else if (regexRaw !== '') {
        const re = parseSlashRegex(regexRaw)
        matcher = l => re.test(l)
      } else {
        throw new Error('provide either text or regex')
      }
      const hits = lines.filter(matcher)
      return {
        content: hits.length === 0 ? 'No matches.' : hits.join('\n'),
      }
    },
  }

  const runCodeUnsafe: PwTool = {
    description:
      'Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent.',
    inputSchema: schema(
      {
        code: {
          type: 'string',
          description:
            'A JavaScript function receiving `page` as its single argument',
        },
      },
      ['code'],
    ),
    exec: async (_ctx, session, args) => {
      const code = requireArg(args, 'code')
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
        ...a: string[]
      ) => (page: Page) => Promise<unknown>
      const fn = new AsyncFunction('page', `return (${code})(page)`)
      const result = await fn(session.page)
      return { content: render(result) }
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
              type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'] },
              value: { type: 'string' },
            },
            required: ['name', 'target', 'type', 'value'],
          },
        },
      },
      ['fields'],
    ),
    exec: async (_ctx, session, args) => {
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
      return { content: `Filled: ${done.join(', ')}` }
    },
  }

  const emulateMedia: PwTool = {
    description: 'Emulate CSS media features for the page.',
    inputSchema: schema(
      {
        colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
        reducedMotion: { type: 'string', enum: ['reduce', 'no-preference'] },
        media: { type: 'string', enum: ['screen', 'print'] },
      },
      [],
    ),
    exec: async (_ctx, session, args) => {
      const opts: Record<string, string> = {}
      for (const k of ['colorScheme', 'reducedMotion', 'media'] as const) {
        const v = strArg(args, k)
        if (v !== '') opts[k] = v
      }
      await session.page.emulateMedia(opts)
      return { content: 'Media emulation applied' }
    },
  }

  const fileUpload: PwTool = {
    description: 'Upload one or multiple files referenced as file:<code>.',
    inputSchema: schema(
      {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: 'File codes (after file:) to upload to the page file chooser',
        },
      },
      ['codes'],
    ),
    exec: async (ctx, session, args) => {
      const codes = strArray(args, 'codes')
      if (codes.length === 0) throw new Error('codes is required')
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
      return { content: `Uploaded ${files.length} file(s)` }
    },
  }

  const handleDialogAlias = dialog

  return {
    browser_create_context: ctxCreate,
    browser_navigate: navigate,
    browser_navigate_back: navigateBack,
    browser_snapshot: snapshot,
    browser_click: click,
    browser_type: type,
    browser_hover: hover,
    browser_select_option: selectOption,
    browser_take_screenshot: takeScreenshot,
    browser_wait_for: waitFor,
    browser_press_key: pressKey,
    browser_evaluate: evaluate,
    browser_resize: resize,
    browser_tabs: tabs,
    browser_console_messages: consoleMessages,
    browser_network_requests: networkRequests,
    browser_network_request: networkRequest,
    browser_handle_dialog: handleDialogAlias,
    browser_drag: drag,
    browser_find: find,
    browser_run_code_unsafe: runCodeUnsafe,
    browser_fill_form: fillForm,
    browser_emulate_media: emulateMedia,
    browser_file_upload: fileUpload,
  }
}

/** Parse `/pattern/flags` or a bare regex into a RegExp. */
function parseSlashRegex(raw: string): RegExp {
  if (raw.startsWith('/')) {
    const last = raw.lastIndexOf('/')
    if (last > 0) {
      const body = raw.slice(1, last)
      const flags = raw.slice(last + 1)
      return new RegExp(body, flags)
    }
  }
  return new RegExp(raw)
}

export { argsWithoutContext }
