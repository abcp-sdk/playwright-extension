import { fileTools } from './files.js'
import { interactionTools } from './interact.js'
import { navigationTools } from './nav.js'
import { observabilityTools } from './observe.js'
import {
  type Exec,
  newContextLogs as newContextLogsImpl,
  wirePageLogging as wirePageLoggingImpl,
} from './shared.js'

// Public surface of the tool layer: tool-shape types, the page-logging
// collectors and the merged tool set. The metadata primitives (schema helpers,
// shared props) are GONE — descriptions/schemas now live in manifest.yaml.
export type { ContextLogs, Exec, ToolCtx } from './shared.js'
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
export function pwTools(): Record<string, Exec> {
  const ctxCreate: Exec = async () => {
    throw new Error('browser-create-context is handled by the router')
  }

  const ctxClose: Exec = async () => {
    throw new Error('browser-close-context is handled by the router')
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
