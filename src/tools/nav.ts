import { tr } from '../i18n.js'
import type { Exec } from './shared.js'
import {
  boolArg,
  captureSnapshot,
  numArg,
  parseSlashRegex,
  render,
  requireArg,
  strArg,
} from './shared.js'

/** Navigation / page-state tools: goto, history, snapshot, find, wait,
 *  viewport, tabs. */
export function navigationTools(): Record<string, Exec> {
  const navigate: Exec = async (ctx, session, args) => {
    const url = requireArg(args, 'url')
    await session.page.goto(url, { waitUntil: 'domcontentloaded' })
    return { content: tr(ctx.locale ?? 'en', 'navigated', { url }) }
  }

  const navigateBack: Exec = async (ctx, session) => {
    await session.page.goBack({ waitUntil: 'domcontentloaded' })
    return {
      content: tr(ctx.locale ?? 'en', 'wentBack', {
        url: session.page.url(),
      }),
    }
  }

  const snapshot: Exec = async (_ctx, session, args) => {
    const target = strArg(args, 'target')
    const depth = numArg(args, 'depth')
    const boxes = boolArg(args, 'boxes')
    const text = await captureSnapshot(session.page, {
      ...(target !== '' ? { target } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(boxes !== undefined ? { boxes } : {}),
    })
    return { content: text }
  }

  const find: Exec = async (ctx, session, args) => {
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
  }

  const waitFor: Exec = async (ctx, session, args) => {
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
  }

  const resize: Exec = async (ctx, session, args) => {
    const width = numArg(args, 'width') ?? 0
    const height = numArg(args, 'height') ?? 0
    await session.page.setViewportSize({ width, height })
    return {
      content: tr(ctx.locale ?? 'en', 'resized', { w: width, h: height }),
    }
  }

  const tabs: Exec = async (ctx, session, args) => {
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
        throw new Error(tr(ctx.locale ?? 'en', 'unknownTabsAction', { action }))
    }
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
