import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import type { MaterialAction } from '../shared/companion-materials'
import { MATERIAL_LIMITS as L } from '../shared/companion-materials'
import { boundedJson } from './history-import-api'
import { HistoryFailure } from './history-archives'
import { MaterialFailure, materialReply } from './companion-materials'

export async function handleCompanionMaterials(request: Request, env: Env, instanceId: string | null): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!/^\/api\/companion-materials(?:\/|$)/.test(url.pathname)) return undefined
  const result = await materialReply(async () => {
    if (request.method !== 'GET' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) throw new MaterialFailure('forbidden', 403)
    if (url.search) throw new MaterialFailure('invalid-data')
    const parts = url.pathname.split('/').slice(3)
    const resource = parts[0]
    let id: string | undefined
    try { id = parts[1] ? decodeURIComponent(parts[1]) : undefined } catch { throw new MaterialFailure('invalid-data') }
    if (parts.length > 2 || parts.some(p => !p)) throw new MaterialFailure('not-found', 404)
    let action: MaterialAction
    if (resource === 'files') {
      if (request.method === 'GET') action = id ? 'file-read' : 'file-list'
      else if (id && request.method === 'POST') action = 'file-create'
      else if (id && request.method === 'PUT') action = 'file-update'
      else if (id && request.method === 'DELETE') action = 'file-delete'
      else throw new MaterialFailure('method-not-allowed', 405)
    } else if (resource === 'memories') {
      if (!id && request.method === 'GET') action = 'memory-list'
      else if (id && request.method === 'PUT') action = 'memory-update'
      else if (id && request.method === 'DELETE') action = 'memory-delete'
      else throw new MaterialFailure('method-not-allowed', 405)
    } else if (resource === 'compaction' && !id) {
      if (request.method === 'GET') action = 'compaction-read'
      else if (request.method === 'PUT') action = 'compaction-save'
      else if (request.method === 'DELETE') action = 'compaction-reset'
      else throw new MaterialFailure('method-not-allowed', 405)
    } else throw new MaterialFailure('not-found', 404)
    let input: unknown
    if (request.method !== 'GET') {
      try { input = await boundedJson(request, L.requestBytes) }
      catch (error) {
        if (error instanceof HistoryFailure) throw new MaterialFailure(error.code === 'resource-limit' ? 'resource-limit' : 'invalid-data', error.status)
        throw error
      }
    }
    const registry = env.PiRegistry.getByName(instanceId ?? 'singleton') as DurableObjectStub<PiRegistry>
    const sessionId = instanceId ? (await registry.ensureDefaultSession()).id : env.COMPANION_SESSION_ID
    if (!sessionId) throw new MaterialFailure('unconfigured', 409)
    if (!await registry.hasReadySession(sessionId)) throw new MaterialFailure('unconfigured', 409)
    const session = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId) as DurableObjectStub<PiSession>
    return session.materialsRequest({ action, id, input })
  })
  return Response.json(result.body, { status: result.status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
}
