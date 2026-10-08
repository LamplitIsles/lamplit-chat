import { bearerMatches, boundedBody, channelConfig, ChannelError, eventIdentity } from './channel-config'
import { parseChannelEvent } from './channel-events'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function handleInboundIngest(request: Request, env: Env, instanceId: string | null): Promise<Response | undefined> {
  const match = /^\/api\/(keet|matrix)\/events$/.exec(new URL(request.url).pathname)
  if (!match) return
  const channel = match[1] as 'keet' | 'matrix'
  try {
    const config = (await channelConfig(env, instanceId))[channel]
    if (!config) throw new ChannelError(404)
    if (!instanceId && !await bearerMatches(request.headers.get('authorization'), config.webhookToken)) throw new ChannelError(401)
    if (request.method !== 'POST') throw new ChannelError(405)
    const body = JSON.parse(await boundedBody(request))
    const event = parseChannelEvent(channel, body, config)
    const registry = env.PiRegistry.getByName(instanceId ?? 'singleton') as DurableObjectStub<import('./pi-registry').PiRegistry>
    const sessionId = instanceId ? await registry.existingDefaultSessionId() : env.COMPANION_SESSION_ID
    if (!sessionId || !SESSION_ID.test(sessionId) || !await registry.hasReadySession(sessionId)) throw new ChannelError(503)
    const stub = env.PiSession.getByName(instanceId ? `${instanceId}:${sessionId}` : sessionId) as DurableObjectStub<import('./pi-session').PiSession>
    const result = await stub.ingestInbound(channel, event, eventIdentity(body))
    if ('error' in result) throw new ChannelError(result.status)
    return Response.json(result, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    const status = error instanceof ChannelError ? error.status : error instanceof SyntaxError ? 400 : 503
    return Response.json({ error: status === 400 ? 'Invalid event' : status === 409 ? 'Conflicting event' : status === 413 ? 'Payload too large' : status === 401 ? 'Unauthorized' : status === 404 ? 'Integration disabled' : status === 405 ? 'Method not allowed' : 'Integration unavailable' }, { status, headers: { 'cache-control': 'no-store' } })
  }
}
