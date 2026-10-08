import { bearerMatches, boundedBody, channelConfig, ChannelError, type Channel } from './channel-config'
import type { PiSession } from './pi-session'
export async function channelIngress(request: Request, env: Env, instanceId: string | null): Promise<Response | undefined> {
  const match = /^\/api\/(keet|matrix)\/events$/.exec(new URL(request.url).pathname)
  if (!match) return undefined
  const respond = (status: number) => Response.json({ status }, { status, headers: { 'cache-control': 'private, no-store' } })
  if (request.method !== 'POST') return respond(405)
  try {
    const channel = match[1] as Channel, configs = await channelConfig(env, instanceId), config = configs[channel]
    if (!config) return respond(404)
    if (!instanceId && !await bearerMatches(request.headers.get('authorization'), config.webhookToken)) return respond(401)
    let sessionId: string | undefined = env.COMPANION_SESSION_ID
    if (instanceId) sessionId = (await env.PiRegistry.getByName(instanceId).ensureDefaultSession()).id
    if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return respond(503)
    const raw = await boundedBody(request)
    const stub = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId) as DurableObjectStub<PiSession>
    return respond(await stub.receiveChannelEvent(channel, raw))
  } catch (error) { return respond(error instanceof ChannelError ? error.status : 503) }
}
