import type { BrowserSession } from '../context-manager.js'
import { tr } from '../i18n.js'
import {
  boolArg,
  ELEMENT_PROP,
  type PwTool,
  requireArg,
  resolveLocator,
  schema,
  strArg,
  strArray,
  TARGET_PROP,
  type ToolCtx,
} from './shared.js'

/**
 * File-producing / file-consuming tools: screenshots, PDFs, uploads, drops and
 * storage-state export/restore. These need the agent's file ingest/get (not
 * expressible as `page.*`).
 */

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

export function fileTools(): Record<string, PwTool> {
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
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page',
        },
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
      const file = await ingest(
        ctx,
        session,
        buf,
        `screenshot-${Date.now()}.${type}`,
      )
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
          description:
            'Paper format, e.g. A4, Letter (default: browser default).',
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
      if (codes.length === 0)
        throw new Error(tr(ctx.locale ?? 'en', 'codesRequired'))
      const files: Array<{ name: string; mimeType: string; buffer: Buffer }> =
        []
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
      return {
        content: tr(ctx.locale ?? 'en', 'uploadedFiles', { n: files.length }),
      }
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
      return {
        content: tr(ctx.locale ?? 'en', 'dropped', {
          target: strArg(args, 'element') || target,
        }),
      }
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
          await page.evaluate(
            (items: Array<{ name: string; value: string }>) => {
              for (const it of items) localStorage.setItem(it.name, it.value)
            },
            o.localStorage ?? [],
          )
        } finally {
          await page.close()
        }
      }
      return {
        content: tr(ctx.locale ?? 'en', 'storageStateRestored', { code }),
      }
    },
  }

  return {
    'browser-take-screenshot': takeScreenshot,
    'browser-pdf-save': pdfSave,
    'browser-file-upload': fileUpload,
    'browser-drop': drop,
    'browser-storage-state': storageState,
    'browser-set-storage-state': setStorageState,
  }
}
