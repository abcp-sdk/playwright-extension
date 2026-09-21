import { tr } from '../i18n.js'
import {
  boolArg,
  captureSnapshot,
  numArg,
  type PwTool,
  parseSlashRegex,
  render,
  requireArg,
  schema,
  strArg,
} from './shared.js'

/** Navigation / page-state tools: goto, history, snapshot, find, wait,
 *  viewport, tabs. */
export function navigationTools(): Record<string, PwTool> {
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
      return {
        content: tr(ctx.locale ?? 'en', 'wentBack', {
          url: session.page.url(),
        }),
      }
    },
  }

  const snapshot: PwTool = {
    description:
      'Capture accessibility snapshot of the current page, this is better than screenshot',
    inputSchema: schema(
      {
        target: {
          type: 'string',
          description:
            'Exact target element reference from the page snapshot (e.g. "e12"), or a Playwright selector.',
        },
        depth: {
          type: 'number',
          description: 'Limit the depth of the snapshot tree',
        },
        boxes: {
          type: 'boolean',
          description:
            'Include each element bounding box as [box=x,y,width,height]',
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

  const find: PwTool = {
    description:
      'Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot lines.',
    inputSchema: schema(
      {
        text: { type: 'string', description: 'Plain text to search for' },
        regex: {
          type: 'string',
          description: 'Regular expression to search for',
        },
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
        content:
          hits.length === 0
            ? tr(ctx.locale ?? 'en', 'noMatches')
            : hits.join('\n'),
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
        textGone: {
          type: 'string',
          description: 'The text to wait to disappear',
        },
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
        await session.page
          .getByText(textGone)
          .first()
          .waitFor({ state: 'hidden' })
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
      return {
        content: tr(ctx.locale ?? 'en', 'resized', { w: width, h: height }),
      }
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
          return {
            content: tr(ctx.locale ?? 'en', 'openedTab', {
              index: context.pages().length - 1,
            }),
          }
        }
        case 'select': {
          const idx = numArg(args, 'index')
          if (idx === undefined || idx < 0 || idx >= pages.length) {
            throw new Error(
              tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: String(idx) }),
            )
          }
          const p = pages[idx]
          if (p === undefined)
            throw new Error(
              tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: idx }),
            )
          await p.bringToFront()
          session.page = p
          return {
            content: tr(ctx.locale ?? 'en', 'selectedTab', { index: idx }),
          }
        }
        case 'close': {
          const idx = numArg(args, 'index')
          const p = idx === undefined ? session.page : pages[idx]
          if (p === undefined)
            throw new Error(
              tr(ctx.locale ?? 'en', 'invalidTabIndex', { index: String(idx) }),
            )
          await p.close()
          const first = context.pages()[0]
          if (first !== undefined) session.page = first
          return { content: tr(ctx.locale ?? 'en', 'closedTab') }
        }
        default:
          throw new Error(
            tr(ctx.locale ?? 'en', 'unknownTabsAction', { action }),
          )
      }
    },
  }

  return {
    'browser-navigate': navigate,
    'browser-navigate-back': navigateBack,
    'browser-snapshot': snapshot,
    'browser-find': find,
    'browser-wait-for': waitFor,
    'browser-resize': resize,
    'browser-tabs': tabs,
  }
}
