import { Extension, connectNatsBus, type Bus } from '@abc-protocol/sdk'
import {
  createPlaywrightExtension,
  type PlaywrightExtensionOpts,
} from './index.js'

export interface ServePlaywrightOpts {
  /** NATS URL the extension connects to (shared with the agent). */
  natsUrl: string
  /** Browser/extension tuning (target, timeouts, caps). */
  extension: Omit<PlaywrightExtensionOpts, 'deps'>
}

/**
 * Connect to NATS and serve the playwright extension. Resolves once the
 * extension has registered (discovery/config/tools/lifecycle subscriptions);
 * returns a stop function for shutdown.
 */
export async function servePlaywright(
  opts: ServePlaywrightOpts,
): Promise<{ stop: () => Promise<void>; bus: Bus }> {
  const bus = await connectNatsBus(opts.natsUrl)
  const bundle = createPlaywrightExtension(bus, opts.extension)
  const ext = new Extension(bus, bundle.config)
  await ext.serve()
  return {
    bus,
    stop: async () => {
      await bundle.stop()
      await ext.close()
    },
  }
}
