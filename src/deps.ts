import type { Bus } from '@abc-protocol/sdk'
import { ingestFileViaAgent, getFileViaAgent } from '@abc-protocol/sdk'

/**
 * The runtime surface the playwright extension relies on. The agent supplies
 * the file-ingest path (it owns the blob + metadata backends), so this
 * extension needs no S3 credentials and no database.
 */
export interface PlaywrightDeps {
  /** Persist arbitrary bytes through the agent and return the canonical
   *  `file:<code>` plus the agent-derived content type. The caller supplies no
   *  mime: the agent derives it from the bytes. */
  ingestFile: (input: {
    name: string
    data: Uint8Array
    session?: string
    tenant?: string
  }) => Promise<{ code: string; mime: string }>
  /** Fetch stored bytes through the agent (used by browser-file-upload and
   *  browser-drop when given a `file:<code>`). */
  getFile: (
    code: string,
    tenant?: string,
  ) => Promise<{ data: Uint8Array; name: string; mime: string }>
}

/**
 * Default deps backed by the agent file RPCs (`abc.<tenant>.file.ingest` /
 * `.get`). Tenant rides the subject; no separate credential is introduced.
 */
export function agentFileDeps(bus: Bus): PlaywrightDeps {
  return {
    ingestFile: async ({ name, data, session, tenant }) => {
      if (tenant === undefined || tenant === '') {
        throw new Error('ingestFile: tenant required')
      }
      const stored = await ingestFileViaAgent(bus, tenant, {
        name,
        data,
        ...(session !== undefined && session !== ''
          ? { sessionName: session }
          : {}),
      })
      return stored
    },
    getFile: async (code, tenant) => {
      if (tenant === undefined || tenant === '') {
        throw new Error('getFile: tenant required')
      }
      const got = await getFileViaAgent(bus, tenant, code)
      if (got === null) throw new Error(`file not found: ${code}`)
      return {
        data: got.data,
        name: got.meta.name,
        mime: got.meta.mime,
      }
    },
  }
}
