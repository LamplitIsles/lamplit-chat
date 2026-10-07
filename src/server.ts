import { handleKeetIngest } from './server/keet-ingest'
import { modelCatalog } from './server/model-catalog'
import { APPEARANCE_PATH } from '@lamplit/contracts'
import { readChatAppearance } from './server/chat-appearance'
import { VOICE_CAPABILITY_PATH, VOICE_STREAM_PATH } from '@lamplit/contracts/voice'
import { handleChatImages } from './server/chat-images-api'
import { handleVoice } from './server/voice'
import { handleSearchTest } from './server/web-tools'
import { handleCompanionMaterials } from './server/companion-materials-api'
import { handleHistory } from './server/history-import-api'
import { routeAgentRequest } from 'agents'
import { PI_AGENT_PREFIX } from './shared/pi-contract'
import { authorize, unauthorized } from './server/auth'
import { handleDisplayNames } from './server/display-names'

export { PiSession } from './server/pi-session'
export { PiRegistry } from './server/pi-registry'

export default {
  async fetch(request: Request, env: Env) {
    const hosted = env.HOSTED_MODE === 'true'
    const instanceId = hosted ? request.headers.get('x-lamplit-instance') : null
    if (hosted && (!env.CHAT_INTERNAL_SECRET || !instanceId || !/^[0-9a-f-]{36}$/.test(instanceId) || request.headers.get('x-lamplit-internal-secret') !== env.CHAT_INTERNAL_SECRET)) {
      return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    if (hosted && !/^\/api\/companion-materials(?:\/|$)/.test(new URL(request.url).pathname) && request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) {
      return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
    }
    const keet = await handleKeetIngest(request, env)
    if (keet) return keet
    const auth = hosted ? { authorized: true } : await authorize(request, env.AUTH_PASSWORD)
    if (!auth.authorized) return unauthorized()
    const respond = (response: Response) => {
      if (!auth.setCookie || response.status === 101) return response
      const headers = new Headers(response.headers)
      headers.set('set-cookie', auth.setCookie)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }
    if (new URL(request.url).pathname === '/internal/model-catalog') {
      if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return respond(new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } }))
      return respond(request.method === 'GET' ? Response.json(modelCatalog(), { headers: { 'cache-control': 'no-store' } }) : new Response('Method not allowed', { status: 405, headers: { 'cache-control': 'no-store' } }))
    }
    if (new URL(request.url).pathname === APPEARANCE_PATH) {
      if (request.method !== 'GET') return respond(new Response('Method not allowed', { status: 405 }))
      return respond(Response.json(await readChatAppearance(env.COMPUTER_R2, instanceId), { headers: { 'cache-control': 'private, no-store' } }))
    }
    const imageResponse = await handleChatImages(request, env, instanceId)
    if (imageResponse) return respond(imageResponse)
    if (new URL(request.url).pathname === '/api/chat/socket') {
      const url = new URL(request.url)
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
      if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403 })
      const registry = env.PiRegistry.getByName(instanceId ?? 'singleton') as DurableObjectStub<import('./server/pi-registry').PiRegistry>
      const sessionId = hosted ? (await registry.ensureDefaultSession()).id : env.COMPANION_SESSION_ID || (await registry.ensureDefaultSession()).id
      const stub = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId)
      return stub.fetch(request)
    }
    if (new URL(request.url).pathname === '/api/web-search/test') return respond(await handleSearchTest(request, env, instanceId))
    if ([VOICE_CAPABILITY_PATH, VOICE_STREAM_PATH].includes(new URL(request.url).pathname)) return respond(await handleVoice(request, env, instanceId))
    const materialResponse = await handleCompanionMaterials(request, env, instanceId)
    if (materialResponse) return respond(materialResponse)
    const historyResponse = await handleHistory(request, env, instanceId)
    if (historyResponse) return respond(historyResponse)
    // Archive identifiers must never instantiate a runnable PiSession, including self-host routes.
    const agentPath = new URL(request.url).pathname
    const agentParts = agentPath.split('/').filter(Boolean)
    // Agents SDK ignores empty segments; reject noncanonical routes before ownership checks.
    if (agentParts[0] === 'api' && agentParts[1] === 'agents' &&
      (agentPath !== `/${agentParts.join('/')}` || (agentParts[2] === 'pi-session' && agentParts[3]?.includes('archive-')))) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } })
    if (hosted && new URL(request.url).pathname.startsWith('/internal/revoke/') && request.method === 'POST') {
      const tokenHash = new URL(request.url).pathname.slice('/internal/revoke/'.length)
      if (!/^[a-f0-9]{64}$/.test(tokenHash)) return new Response('Not found', { status: 404 })
      const registry = env.PiRegistry.getByName(instanceId!) as unknown as { revokePersonalSession(tokenHash: string): Promise<void> }
      await registry.revokePersonalSession(tokenHash)
      return new Response(null, { status: 204 })
    }
    if (new URL(request.url).pathname === '/api/companion-config') {
      const registry = instanceId ? env.PiRegistry.getByName(instanceId) as unknown as { ensureDefaultSession(): Promise<{ id: string }> } : null
      const sessionId = registry ? (await registry.ensureDefaultSession()).id : env.COMPANION_SESSION_ID || null
      return respond(Response.json({ sessionId, photosEnabled: Boolean(env.COMPUTER_R2), accountSettingsHref: hosted ? '/settings' : null }, { headers: { 'cache-control': 'private, no-store' } }))
    }
    if (new URL(request.url).pathname === '/api/display-names') return respond(await handleDisplayNames(request, env.COMPUTER_R2, instanceId))
    if (new URL(request.url).pathname.startsWith('/api/ui-assets')) {
      const url = new URL(request.url)
      const slot = url.pathname.split('/')[3]
      const slots = ['avatar', 'user-avatar', 'background'] as const
      const bucket = env.COMPUTER_R2
      const prefix = `${instanceId ? `instances/${instanceId}/` : ''}ui-assets/`
      if (url.pathname === '/api/ui-assets' && request.method === 'GET') {
        const objects = bucket ? await Promise.all(slots.map((name) => bucket.head(`${prefix}${name}`))) : []
        return respond(Response.json({ assets: objects.flatMap((object, index) => object ? [{ slot: slots[index], mediaType: object.httpMetadata?.contentType }] : []) }))
      }
      if (!slots.some((name) => name === slot)) return new Response('Not found', { status: 404 })
      if (!env.COMPUTER_R2) return new Response('Image storage is unavailable', { status: 404 })
      const key = `${prefix}${slot}`
      if (request.method === 'GET') {
        const object = await env.COMPUTER_R2.get(key)
        if (!object) return new Response('Image object is missing', { status: 404 })
        return respond(new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } }))
      }
      if (request.method === 'PUT' || request.method === 'DELETE') {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
        if (request.method === 'DELETE') {
          await env.COMPUTER_R2.delete(key)
          return respond(new Response(null, { status: 204 }))
        }
        const mediaType = request.headers.get('content-type')?.split(';')[0]
        if (!mediaType || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) return new Response('Unsupported image type', { status: 415 })
        if (Number(request.headers.get('content-length') ?? 0) > 8_000_000) return new Response('Image exceeds 8 MB', { status: 413 })
        const bytes = new Uint8Array(await request.arrayBuffer())
        if (bytes.byteLength > 8_000_000 || !validImageBytes(bytes, mediaType)) return new Response('Invalid image', { status: 400 })
        await env.COMPUTER_R2.put(key, bytes, { httpMetadata: { contentType: mediaType } })
        return respond(Response.json({ slot, mediaType }))
      }
      return new Response('Method not allowed', { status: 405 })
    }
    const photoResponse = await handleConversationPhotos(request, env, instanceId)
    if (photoResponse) return respond(photoResponse)
    if (hosted && new URL(request.url).pathname.startsWith('/api/agents/')) {
      const url = new URL(request.url)
      const parts = url.pathname.split('/')
      if (parts[3] === 'pi-registry' && parts[4] === 'singleton') parts[4] = instanceId!
      else if (parts[3] === 'pi-session' && (parts[4] === 'default' || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parts[4] ?? ''))) {
        const registry = env.PiRegistry.getByName(instanceId!) as unknown as { ensureDefaultSession(): Promise<{ id: string }>; hasReadySession(id: string): Promise<boolean> }
        const sessionId = parts[4] === 'default' ? (await registry.ensureDefaultSession()).id : parts[4]
        if (parts[4] !== 'default' && !await registry.hasReadySession(sessionId)) return new Response('Not found', { status: 404 })
        parts[4] = `${instanceId}:${sessionId}`
      } else return new Response('Not found', { status: 404 })
      url.pathname = parts.join('/')
      request = new Request(url, request)
    }
    const agentResponse = await routeAgentRequest(request, env, { prefix: PI_AGENT_PREFIX })
    if (agentResponse) return respond(agentResponse)
    const assetUrl = new URL(request.url)
    const path = assetUrl.pathname
    // Only the two current entries receive the shared shell. Missing routes/assets
    // must never become HTML, including the retired /slice mount.
    if (path === '/' || path === '/chat') assetUrl.pathname = '/index.html'
    else if (!path.startsWith('/assets/') && !path.startsWith('/icons/') && !(path === '/manifest.webmanifest' && !hosted)) {
      return respond(new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } }))
    }
    return respond(await env.ASSETS.fetch(new Request(assetUrl, request)))
  },
} satisfies ExportedHandler<Env>

function validImageBytes(bytes: Uint8Array, mediaType: string): boolean {
  if (mediaType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
  if (mediaType === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  if (mediaType === 'image/gif') return bytes.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.subarray(0, 6)))
  return mediaType === 'image/webp' && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
}

export async function handleConversationPhotos(request: Request, env: Env, instanceId: string | null = null): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/conversation-images/')) return undefined
  if (request.method !== 'GET' && request.method !== 'DELETE') return new Response('Method not allowed', { status: 405 })
  const parts = url.pathname.split('/').slice(3)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const sessionId = parts[0]
  if (!sessionId || !uuid.test(sessionId) || (env.COMPANION_SESSION_ID && sessionId !== env.COMPANION_SESSION_ID)) return new Response('Not found', { status: 404 })
  if (instanceId) {
    const registry = env.PiRegistry.getByName(instanceId) as unknown as { hasReadySession(id: string): Promise<boolean> }
    if (!await registry.hasReadySession(sessionId)) return new Response('Not found', { status: 404 })
  }
  const stub = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId) as unknown as {
    listConversationPhotos(input: { cursor?: string; limit?: number }): Promise<{ images: Array<{ id: string; name: string; created: number }>; nextCursor?: string }>
    readConversationPhoto(id: string, variant: 'original' | 'preview', operationId?: string): Promise<Response>
    deleteConversationPhoto(id: string): Promise<void>
  }
  if (parts.length === 1 && request.method === 'GET') {
    try {
      const page = await stub.listConversationPhotos({ cursor: url.searchParams.get('cursor') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 30) })
      return Response.json({ images: page.images.map((photo) => ({ id: photo.id, filename: photo.name, created: photo.created, origin: 'conversation', available: true, url: `/api/conversation-images/${sessionId}/${photo.id}/preview` })), nextCursor: page.nextCursor })
    } catch { return new Response('Invalid album request', { status: 400 }) }
  }
  if (parts.length === 3 && request.method === 'GET' && uuid.test(parts[1]) && (parts[2] === 'original' || parts[2] === 'preview')) {
    return stub.readConversationPhoto(parts[1], parts[2], url.searchParams.get('operation') ?? undefined)
  }
  if (parts.length === 2 && uuid.test(parts[1]) && request.method === 'DELETE') {
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
    try { await stub.deleteConversationPhoto(parts[1]); return new Response(null, { status: 204 }) }
    catch { return new Response('Photo not found', { status: 404 }) }
  }
  return new Response('Not found', { status: 404 })
}
