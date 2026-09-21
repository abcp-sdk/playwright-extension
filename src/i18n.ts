import { BASE_LOCALE, type Catalog, defineI18n } from '@abc-protocol/sdk'
import type { PlaywrightDeps } from './deps.js'

/**
 * Playwright-extension message catalog for RUNTIME tool text (content + error)
 * that reaches the model. (Tool DESCRIPTIONS are internal English constants —
 * the extension's localisation convention is the description/manifest path.)
 *
 * The locale set is an OPEN map — add a language by adding a column. New keys
 * are type-checked, so a typo in `t(locale, '...')` fails to compile.
 */
export const CATALOG = {
  contextIdRequired: {
    en: 'context_id is required — call browser-create-context first',
    zh: '缺少 context_id —— 请先调用 browser-create-context。',
  },
  contextIdRequiredUnlessAll: {
    en: 'context_id is required unless all=true',
    zh: '除非 all=true，否则必须提供 context_id。',
  },
  navigated: { en: 'Navigated to {url}', zh: '已导航至 {url}' },
  wentBack: { en: 'Went back to {url}', zh: '已后退至 {url}' },
  clicked: { en: 'Clicked {target}', zh: '已点击 {target}' },
  typed: { en: 'Typed into {target}', zh: '已在 {target} 输入' },
  hovered: { en: 'Hovered {target}', zh: '已悬停 {target}' },
  selected: { en: 'Selected {values}', zh: '已选择 {values}' },
  pressed: { en: 'Pressed {key}', zh: '已按下 {key}' },
  resized: { en: 'Resized to {w}x{h}', zh: '已调整为 {w}x{h}' },
  openedTab: { en: 'Opened tab {index}', zh: '已打开标签页 {index}' },
  selectedTab: { en: 'Selected tab {index}', zh: '已选择标签页 {index}' },
  invalidTabIndex: {
    en: 'invalid tab index {index}',
    zh: '无效的标签页索引 {index}',
  },
  unknownTabsAction: {
    en: 'unknown tabs action: {action}',
    zh: '未知的 tabs 操作：{action}',
  },
  filled: { en: 'Filled: {fields}', zh: '已填写：{fields}' },
  nextDialog: {
    en: 'Next dialog will be {state}',
    zh: '下一个对话框将被{state}',
  },
  dialogAccepted: { en: 'accepted', zh: '接受' },
  dialogDismissed: { en: 'dismissed', zh: '关闭' },
  provideTextOrRegex: {
    en: 'provide either text or regex',
    zh: '请提供 text 或 regex。',
  },
  noRequestAtIndex: {
    en: 'no request at index {index}',
    zh: '索引 {index} 处没有请求。',
  },
  screenshotSaved: {
    en: 'Screenshot saved as file:{code} ({mime}, {bytes} bytes)',
    zh: '截图已保存为 file:{code}（{mime}，{bytes} 字节）',
  },
  pdfSaved: {
    en: 'PDF saved as file:{code} ({mime}, {bytes} bytes)',
    zh: 'PDF 已保存为 file:{code}（{mime}，{bytes} 字节）',
  },
  pdfHeadlessOnly: {
    en: 'pdf failed (PDF is only supported in headless Chromium): {detail}',
    zh: 'pdf 失败（仅无头 Chromium 支持 PDF）：{detail}',
  },
  codesRequired: { en: 'codes is required', zh: '缺少 codes。' },
  uploadedFiles: { en: 'Uploaded {n} file(s)', zh: '已上传 {n} 个文件' },
  dropped: { en: 'Dropped onto {target}', zh: '已拖放到 {target}' },
  storageStateSaved: {
    en: 'Storage state saved as file:{code} ({bytes} bytes)',
    zh: '存储状态已保存为 file:{code}（{bytes} 字节）',
  },
  storageStateRestored: {
    en: 'Storage state restored from file:{code}',
    zh: '已从 file:{code} 恢复存储状态',
  },
  createdContext: {
    en: 'Created browser context. context_id: {id}',
    zh: '已创建浏览器上下文。context_id：{id}',
  },
  closedContexts: {
    en: 'Closed {n} browser context(s)',
    zh: '已关闭 {n} 个浏览器上下文',
  },
  closedContext: {
    en: 'Closed browser context {id}',
    zh: '已关闭浏览器上下文 {id}',
  },
  closedTab: { en: 'Closed tab', zh: '已关闭标签页' },
  waitCompleted: { en: 'Wait completed', zh: '等待完成' },
  dragged: { en: 'Dragged element', zh: '已拖拽元素' },
  noMatches: { en: 'No matches.', zh: '没有匹配项。' },
  noConsoleMessages: { en: 'No console messages.', zh: '没有控制台消息。' },
  noNetworkRequests: { en: 'No network requests.', zh: '没有网络请求。' },
  noBrowserTarget: {
    en: 'no browser target configured',
    zh: '未配置浏览器目标。',
  },
} satisfies Catalog<string>

export type MessageKey = keyof typeof CATALOG

const { t } = defineI18n(CATALOG)

/** Translate a playwright message into `locale`. */
export function tr(
  locale: string,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return t(locale, key, params)
}

/** Read the session's effective locale (agent-projected), fallback `en`. */
export async function localeOf(
  deps: PlaywrightDeps,
  tenant: string,
  session: string,
): Promise<string> {
  if (session === '') return BASE_LOCALE
  const v = await deps
    .getSessionVariable(tenant, 'agent', session, 'locale')
    .catch(() => '')
  return v === '' ? BASE_LOCALE : v
}
