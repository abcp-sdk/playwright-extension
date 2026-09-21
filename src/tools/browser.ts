import { fileTools } from './files.js'
import { interactionTools } from './interact.js'
import { navigationTools } from './nav.js'
import { observabilityTools } from './observe.js'
import {
  newContextLogs as newContextLogsImpl,
  type PwTool,
  wirePageLogging as wirePageLoggingImpl,
} from './shared.js'

// Compat re-exports: the tool-shape primitives + page-logging collectors
// moved to ./shared.ts; index.ts and existing importers keep importing them
// from THIS module's public surface.
export {
  CONTEXT_PROP,
  type ContextLogs,
  ELEMENT_PROP,
  type Exec,
  type PwTool,
  schema,
  TARGET_PROP,
  type ToolCtx,
} from './shared.js'
export const newContextLogs = newContextLogsImpl
export const wirePageLogging = wirePageLoggingImpl

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
 * lifecycle). The definitions live in per-domain modules (nav / interact /
 * observe / files); this is the merge point.
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

  return {
    'browser-create-context': ctxCreate,
    'browser-close-context': ctxClose,
    ...navigationTools(),
    ...interactionTools(),
    ...observabilityTools(),
    ...fileTools(),
  }
}
