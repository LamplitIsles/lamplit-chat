import { imageHttp } from '@lamplit/contracts/server'
import { PI_IMAGE_LIMITS } from './chat-images'
import type { PiRegistry } from './pi-registry'
import type { PiSession, ChatImageOwner } from './pi-session'

export async function handleChatImages(request: Request, env: Env, instanceId: string | null): Promise<Response | undefined> {
  const path = new URL(request.url).pathname
  if (path !== '/api/chat/images' && !path.startsWith('/api/chat/media/')) return
  const registry = env.PiRegistry.getByName(instanceId ?? 'singleton') as DurableObjectStub<PiRegistry>
  const sessionId = instanceId ? (await registry.ensureDefaultSession()).id : env.COMPANION_SESSION_ID || (await registry.ensureDefaultSession()).id
  const owner: ChatImageOwner = { sessionId, instanceId, tokenHash: request.headers.get('x-lamplit-session-hash') }
  const stub = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId) as DurableObjectStub<PiSession>
  return imageHttp(request, {
    upload: input => stub.uploadChatImages(input, owner),
    media: (id, variant) => stub.readChatImage(id, variant, owner),
  }, async () => {
    try { await stub.authorizeChatImages(owner); return { sessionId, limits: env.COMPUTER_R2 ? PI_IMAGE_LIMITS : false } } catch { return null }
  })
}
