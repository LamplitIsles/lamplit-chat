import { readResponseText } from './web-request'
import { parseKeetFrame } from './keet-feed'

const MAX_BODY = 112 * 1024
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type KeetStub = {
  ingestKeet(frame: ReturnType<typeof parseKeetFrame>): Promise<{ sequence: number; queued: boolean } | { error: string; retryable?: boolean }>
}

export async function handleKeetIngest(request: Request, env: Env): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  if (pathname !== '/api/keet/events') return
  if (env.HOSTED_MODE === 'true') return new Response('Hosted Keet ingress is not provisioned.', { status: 503 })
  if (!env.KEET_INGEST_TOKEN || !await authorized(request.headers.get('authorization'), env.KEET_INGEST_TOKEN)) return new Response('Unauthorized', { status: 401 })
  const sessionId = env.COMPANION_SESSION_ID
  if (!sessionId || !SESSION_ID.test(sessionId)) return new Response('COMPANION_SESSION_ID must identify an initialized session.', { status: 503 })
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<import('./pi-registry').PiRegistry>
  if (!await registry.hasReadySession(sessionId)) return new Response('COMPANION_SESSION_ID must identify an initialized session.', { status: 503 })
  const stub: KeetStub = env.PiSession.getByName(sessionId) as DurableObjectStub<import('./pi-session').PiSession>
  try {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return new Response('Event too large', { status: 413 })
    if (!request.body) throw new Error('Missing event body.')
    const body = await readResponseText(request, MAX_BODY)
    const frame = parseKeetFrame(JSON.parse(body))
    const result = await stub.ingestKeet(frame)
    if ('error' in result) return Response.json(result, { status: result.retryable ? 503 : /gap|conflict|already admitted/.test(result.error) ? 409 : 400 })
    return Response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Keet ingestion failed.'
    const status = /gap|conflict|already admitted/.test(message) ? 409 : /not been initialized/.test(message) ? 503 : /too large|byte limit/.test(message) ? 413 : 400
    return Response.json({ error: status === 400 ? 'Invalid Keet event.' : status === 413 ? 'Event too large.' : message.slice(0, 300) }, { status })
  }
}

async function authorized(header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith('Bearer ')) return false
  const actual = new TextEncoder().encode(header.slice(7))
  const expected = new TextEncoder().encode(secret)
  if (actual.length !== expected.length) return false
  return (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean }).timingSafeEqual(actual, expected)
}
