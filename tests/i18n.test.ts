import { describe, expect, it } from 'vitest'
import { CATALOG, tr } from '../src/i18n.js'

describe('playwright i18n', () => {
  it('renders English by default', () => {
    expect(tr('en', 'navigated', { url: 'https://x' })).toBe(
      'Navigated to https://x',
    )
    expect(tr('', 'pressed', { key: 'Enter' })).toBe('Pressed Enter')
  })

  it('renders Chinese for zh locales', () => {
    expect(tr('zh', 'navigated', { url: 'https://x' })).toBe(
      '已导航至 https://x',
    )
    expect(tr('zh-CN', 'resized', { w: 800, h: 600 })).toBe('已调整为 800x600')
  })

  it('falls back to English for an unknown locale', () => {
    expect(tr('de', 'waitCompleted')).toBe('Wait completed')
  })

  it('every catalog entry carries en + zh', () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      expect(entry.en, `${key}.en`).toBeTypeOf('string')
      expect(entry.zh, `${key}.zh`).toBeTypeOf('string')
      expect(entry.en.length, `${key}.en non-empty`).toBeGreaterThan(0)
      expect(entry.zh.length, `${key}.zh non-empty`).toBeGreaterThan(0)
    }
  })
})
