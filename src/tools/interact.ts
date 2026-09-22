import type { Page } from 'playwright-core'
import { tr } from '../i18n.js'
import type { Exec } from './shared.js'
import {
  boolArg,
  render,
  requireArg,
  resolveLocator,
  strArg,
  strArray,
} from './shared.js'

/** Interaction tools: click/type/hover/select/press/drag/forms/dialogs and
 *  the two (deliberately unsafe) code-evaluation escapes. */
export function interactionTools(): Record<string, Exec> {
  const click: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const loc = resolveLocator(session.page, target)
    const dbl = boolArg(args, 'doubleClick') ?? false
    const button = (strArg(args, 'button') || 'left') as
      | 'left'
      | 'right'
      | 'middle'
    const modifiers = strArray(args, 'modifiers') as Array<
      'Alt' | 'Control' | 'Meta' | 'Shift'
    >
    await loc.click({
      ...(dbl ? { clickCount: 2 } : {}),
      button,
      ...(modifiers.length > 0 ? { modifiers } : {}),
    })
    return {
      content: tr(ctx.locale ?? 'en', 'clicked', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const type: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const text = requireArg(args, 'text')
    const loc = resolveLocator(session.page, target)
    if (boolArg(args, 'slowly') === true) {
      await loc.pressSequentially(text)
    } else {
      await loc.fill(text)
    }
    if (boolArg(args, 'submit') === true) await loc.press('Enter')
    return {
      content: tr(ctx.locale ?? 'en', 'typed', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const hover: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    await resolveLocator(session.page, target).hover()
    return {
      content: tr(ctx.locale ?? 'en', 'hovered', {
        target: strArg(args, 'element') || target,
      }),
    }
  }

  const selectOption: Exec = async (ctx, session, args) => {
    const target = requireArg(args, 'target')
    const values = strArray(args, 'values')
    await resolveLocator(session.page, target).selectOption(values)
    return {
      content: tr(ctx.locale ?? 'en', 'selected', {
        values: values.join(', '),
      }),
    }
  }

  const pressKey: Exec = async (ctx, session, args) => {
    const key = requireArg(args, 'key')
    await session.page.keyboard.press(key)
    return { content: tr(ctx.locale ?? 'en', 'pressed', { key }) }
  }

  const drag: Exec = async (ctx, session, args) => {
    const start = resolveLocator(session.page, requireArg(args, 'startTarget'))
    const end = resolveLocator(session.page, requireArg(args, 'endTarget'))
    await start.dragTo(end)
    return { content: tr(ctx.locale ?? 'en', 'dragged') }
  }

  const fillForm: Exec = async (ctx, session, args) => {
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
    return {
      content: tr(ctx.locale ?? 'en', 'filled', { fields: done.join(', ') }),
    }
  }

  const handleDialog: Exec = async (ctx, session, args) => {
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
  }

  const evaluate: Exec = async (_ctx, session, args) => {
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
  }

  const runCodeUnsafe: Exec = async (_ctx, session, args) => {
    const code = requireArg(args, 'code')
    const AsyncFunction = Object.getPrototypeOf(async () => {})
      .constructor as new (
      ...a: string[]
    ) => (page: Page) => Promise<unknown>
    const fn = new AsyncFunction('page', `return (${code})(page)`)
    const result = await fn(session.page)
    return { content: render(result) }
  }

  return {
    'browser-click': click,
    'browser-type': type,
    'browser-hover': hover,
    'browser-select-option': selectOption,
    'browser-press-key': pressKey,
    'browser-drag': drag,
    'browser-fill-form': fillForm,
    'browser-handle-dialog': handleDialog,
    'browser-evaluate': evaluate,
    'browser-run-code-unsafe': runCodeUnsafe,
  }
}
