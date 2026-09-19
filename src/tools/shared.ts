import type { Locator, Page } from 'playwright-core'

/** Read a string tool argument (missing/typed wrong = ""). */
export function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export function numArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function boolArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}

export function strArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

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

export function requireArg(
  args: Record<string, unknown>,
  key: string,
): string {
  const v = strArg(args, key)
  if (v === '') throw new Error(`${key} is required`)
  return v
}
