import type { Bus } from '@abc-protocol/sdk'
import {
  getFileViaAgent,
  ingestFileViaAgent,
  sessionVarKey,
  VARS_BUCKET,
} from '@abc-protocol/sdk'

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
  /**
   * Read a session variable the agent projects (vars bucket, provider "agent"),
   * e.g. `locale`. Returns '' when unset. Used to localize tool results.
   */
  getSessionVariable: (
    tenant: string,
    provider: string,
    sessionName: string,
    name: string,
  ) => Promise<string>
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
    getSessionVariable: async (tenant, provider, sessionName, name) => {
      if (sessionName === '') return ''
      try {
        const v = await bus.kvGet(
          VARS_BUCKET,
          sessionVarKey(tenant, provider, sessionName, name),
        )
        return v ?? ''
      } catch {
        return ''
      }
    },
  }
}
