import { HISTORY_LIMITS as L, HistoryDiagnosticSchema, type HistoryReply } from '../shared/history-import'
import { check, HistoryFailure } from './history-archives'

export async function boundedJson(request: Request, max: number = L.requestBytes): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new HistoryFailure('invalid-data', 415)
  if (Number(request.headers.get('content-length')) > max) throw new HistoryFailure('resource-limit', 413)
  if (!request.body) throw new HistoryFailure('invalid-data')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > max) { await reader.cancel(); throw new HistoryFailure('resource-limit', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const joined = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) }
  catch { throw new HistoryFailure('invalid-data') }
}
export async function hashSourceId(sourceId: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceId)))
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')
}
export async function safeDiagnostic(input: unknown, issueId: string): Promise<Record<string, unknown>> {
  const event = check(HistoryDiagnosticSchema, input)
  const { sourceId, filename, issueId: existingIssueId, ...safe } = event
  // Keep only a basename with a source-specific archive suffix, never paths, control characters or key-shaped names.
  const basename = filename?.normalize('NFKC').split(/[\\/]/).at(-1)?.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
  const suffix = event.source === 'operit' ? /\.json$/i : /\.zip$/i
  const validFilename = basename && suffix.test(basename) && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_. -]{0,115}\.(?:zip|json)$/iu.test(basename) && !/(?:sk-|gh[pousr]_|AKIA|key|token|secret|password)/i.test(basename)
  const sourceIdHash = sourceId ? await hashSourceId(sourceId) : undefined
  return { event: 'history-import', issueId: existingIssueId ?? issueId, ...safe, ...(validFilename ? { filename: basename } : {}), ...(sourceIdHash ? { sourceIdHash } : {}) }
}
export async function handleHistory(request: Request, env: Env, instanceId: string | null): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!/^\/api\/history-(?:import|archives)(?:\/|$)/.test(url.pathname)) return undefined
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
  const registry = env.PiRegistry.getByName(instanceId ?? 'singleton') as {
    historyRequest(action: string, params: { id?: string; input?: unknown; after?: string | number; limit?: number }): Promise<HistoryReply>
    historyFailure(event: { issueId: string; stage: string; code: string }): Promise<void>
  }
  let action = 'request'
  try {
    if (request.method !== 'GET' && request.headers.get('origin') && request.headers.get('origin') !== url.origin) throw new HistoryFailure('forbidden', 403)
    const parts = url.pathname.split('/').slice(3)
    const id = parts[0] ?? ''
    if (url.pathname.startsWith('/api/history-archives')) {
      if (request.method !== 'GET') throw new HistoryFailure('method-not-allowed', 405)
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const cursor = url.searchParams.get('cursor') ?? ''
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > L.pageLimit || cursor.length > 200 || parts.length > 1) throw new HistoryFailure('invalid-data')
      action = id ? 'read' : 'list'
      const after = id ? Number(cursor || 0) : cursor
      if (id && (!Number.isSafeInteger(after) || Number(after) < 0)) throw new HistoryFailure('invalid-data')
      const result: HistoryReply = await registry.historyRequest(action, { id, after, limit })
      return reply(result.body, result.status)
    }
    if (!id && request.method === 'GET') action = 'settings'
    else if (!id && request.method === 'POST') action = 'start'
    else if (id === 'diagnostics' && parts.length === 1 && request.method === 'POST') action = 'diagnostics'
    else if (parts.length === 1 && /^[0-9a-f-]{36}$/.test(id) && request.method === 'GET') action = 'status'
    else if (parts.length === 1 && /^[0-9a-f-]{36}$/.test(id) && request.method === 'DELETE') action = 'cancel'
    else if (parts.length === 2 && /^[0-9a-f-]{36}$/.test(id) && request.method === 'POST' && ['append', 'commit'].includes(parts[1])) action = parts[1]
    else throw new HistoryFailure('not-found', 404)
    const input = request.method === 'POST' ? await boundedJson(request, action === 'diagnostics' ? L.diagnosticBytes : L.requestBytes) : undefined
    const result: HistoryReply = await registry.historyRequest(action, { id, input })
    return reply(result.body, result.status)
  } catch (error) {
    const failure = error instanceof HistoryFailure ? error : new HistoryFailure('internal-error', 500)
    const issueId = crypto.randomUUID()
    // Diagnostic storage failure must not replace the controlled API error with a raw RPC exception.
    await registry.historyFailure({ issueId, stage: action, code: failure.code }).catch(() => {})
    return reply({ error: { code: failure.code, stage: action, issueId } }, failure.status)
  }
}
