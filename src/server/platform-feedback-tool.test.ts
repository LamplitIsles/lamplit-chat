import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { createPlatformFeedbackTools, type FeedbackEnvironment } from './platform-feedback-tool'
const instance = '11111111-1111-4111-8111-111111111111'
const session = '22222222-2222-4222-8222-222222222222'
const receipt = { id: '33333333-3333-4333-8333-333333333333', source: 'machine', status: 'received', created_at: '2026-10-01T00:00:00.000Z', problem: 'PRIVATE', account: 'PRIVATE@example.invalid' }
const input = { problem: ' problem ', circumstances: ' circumstances ', expected_improvement: ' improvement ' }
function setup(fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ feedback: receipt }, { status: 201 }))) {
  const env: FeedbackEnvironment = { HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'SECRET-fixture', PLATFORM: { fetch } }
  const call = async (value: unknown = input, id = 'call', signal?: AbortSignal, sessionId = session) => {
    const tool = createPlatformFeedbackTools(env, instance, sessionId)[0]
    const result = await tool.execute(id, value as never, () => {}, undefined, undefined!, { ...BACKGROUND_CONTEXT, abortSignal: signal })
    return JSON.parse((result.content[0] as { text: string }).text)
  }
  return { env, fetch, call }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('platform feedback execute', () => {
  it('sends only descriptions and stable UUID using trusted identities and returns a minimal receipt', async () => {
    const { call, fetch, env } = setup()
    env.PLATFORM_ORIGIN = 'https://app.fixture.invalid'
    expect(await call()).toEqual({ ok: true, id: receipt.id, source: 'machine', status: 'received', created_at: receipt.created_at, message: expect.stringContaining('My feedback') })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(`https://app.fixture.invalid/internal/chat-feedback/${instance}`)
    const request = new Request(url, init)
    expect(request.method).toBe('POST')
    expect(request.redirect).toBe('manual')
    expect(request.credentials).toBe('omit')
    expect(request.headers.get('x-lamplit-internal-secret')).toBe('SECRET-fixture')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(request.headers.has('cookie')).toBe(false)
    const payload = JSON.parse(init!.body as string)
    expect(payload).toEqual({ problem: 'problem', circumstances: 'circumstances', expected_improvement: 'improvement', submission_key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) })
    fetch.mockImplementation(async () => Response.json({ feedback: receipt }))
    await call(); await call(input, 'other'); await call(input, 'call', undefined, instance)
    const keys = fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string).submission_key)
    expect(keys[0]).toBe(keys[1]); expect(new Set(keys).size).toBe(3)
    await createPlatformFeedbackTools(env, receipt.id, session)[0].execute('call', input, () => {}, undefined, undefined!, BACKGROUND_CONTEXT)
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string).submission_key).not.toBe(keys[0])
    expect(JSON.stringify(await call())).not.toMatch(/PRIVATE|SECRET|account|problem/)
  })
  it('fails closed for unavailable identities and configuration, and missing call IDs', async () => {
    const { env, call, fetch } = setup()
    for (const hosted of [undefined, 'false', 'TRUE']) expect(createPlatformFeedbackTools({ ...env, HOSTED_MODE: hosted }, instance, session)).toEqual([])
    for (const identity of [null, 'malformed', '-'.repeat(36)]) expect(createPlatformFeedbackTools(env, identity, session)).toEqual([])
    expect(createPlatformFeedbackTools(env, instance, 'bad')).toEqual([])
    expect(await call(input, '')).toMatchObject({ ok: false, code: 'missing_call_id', outcome: 'not_sent' })
    env.PLATFORM = undefined
    expect(await call()).toMatchObject({ code: 'service_unavailable', outcome: 'not_sent' })
    env.PLATFORM = { fetch }; env.CHAT_INTERNAL_SECRET = ' '
    expect(await call()).toMatchObject({ code: 'service_unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('validates real Unicode and JSON byte boundaries and rejects all model-controlled metadata', async () => {
    const { call, fetch } = setup()
    for (const value of [null, [], {}, { problem: ' ' }, { problem: 2 }, { problem: 'x', circumstances: null }, ...['account', 'source', 'created_at', 'status', 'submission_key', 'instanceId', 'sessionId'].map(key => ({ problem: 'x', [key]: 'forged' })), ...['problem', 'circumstances', 'expected_improvement'].map(field => ({ problem: 'x', [field]: '😀'.repeat(4001) }))]) {
      expect(await call(value)).toMatchObject({ ok: false, code: 'invalid_input', outcome: 'not_sent' })
    }
    expect(await call({ problem: 'x', circumstances: '\u0000'.repeat(4000), expected_improvement: '\u0000'.repeat(4000) })).toMatchObject({ ok: true })
    expect(await call({ problem: '\u0000'.repeat(4000), circumstances: '\u0000'.repeat(4000), expected_improvement: '\u0000'.repeat(4000) })).toMatchObject({ code: 'invalid_input' })
    expect(await call({ problem: '😀'.repeat(4000), circumstances: '😀'.repeat(4000), expected_improvement: '😀'.repeat(4000) })).toMatchObject({ ok: true })
    expect(await call({ problem: 'x' })).toMatchObject({ ok: true })
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ circumstances: '', expected_improvement: '' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([[401, 'forbidden'], [403, 'forbidden'], [404, 'instance_not_found'], [400, 'invalid_input'], [413, 'invalid_input'], [409, 'submission_conflict'], [503, 'upstream_error'], [302, 'upstream_error'], [202, 'upstream_error']])('handles HTTP %i without upstream body disclosure', async (status, code) => {
    const { call, fetch } = setup()
    fetch.mockImplementation(async () => new Response('PRIVATE SECRET account', { status }))
    const value = await call()
    expect(value).toMatchObject({ ok: false, code, outcome: status >= 500 || status === 302 || status === 202 ? 'unconfirmed' : 'rejected' })
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|SECRET|account/)
  })
  it('rejects invalid receipts and excessive response bodies', async () => {
    const { call, fetch } = setup()
    for (const body of ['{', JSON.stringify({}), ...[{ id: 'bad' }, { source: 'human' }, { status: 'invented' }, { created_at: 'yesterday' }, { created_at: '2026-99-01T00:00:00Z' }, { created_at: '2026-02-31T00:00:00Z' }].map(change => JSON.stringify({ feedback: { ...receipt, ...change } })), 'x'.repeat(65537)]) {
      fetch.mockImplementation(async () => new Response(body))
      expect(await call()).toMatchObject({ ok: false, code: 'invalid_response', outcome: 'unconfirmed' })
    }
  })
  it('reports disconnect, timeout and cancellation as unconfirmed after sending; pre-abort sends nothing', async () => {
    const { call, fetch } = setup()
    fetch.mockRejectedValue(new Error('SECRET PRIVATE account'))
    expect(await call()).toMatchObject({ code: 'upstream_error', outcome: 'unconfirmed', message: expect.stringContaining('may have been saved') })
    fetch.mockClear()
    const controller = new AbortController(); controller.abort()
    expect(await call(input, 'call', controller.signal)).toMatchObject({ code: 'cancelled', outcome: 'not_sent' })
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('fixture', 'AbortError')))))
    const inflight = new AbortController()
    const pending = call(input, 'call', inflight.signal)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); inflight.abort()
    expect(await pending).toMatchObject({ code: 'cancelled', outcome: 'unconfirmed' })
    vi.useFakeTimers()
    const timeout = call()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(10000)
    expect(await timeout).toMatchObject({ code: 'timeout', outcome: 'unconfirmed' })
  })
})

it('bounds streamed response reads with timeout and caller abort', async () => {
  const { call, fetch } = setup()
  const makeBody = () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"feedback":')) } }))
  fetch.mockImplementation(async () => makeBody())
  const controller = new AbortController()
  const cancelled = call(input, 'call', controller.signal)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  controller.abort()
  expect(await cancelled).toMatchObject({ code: 'cancelled', outcome: 'unconfirmed' })
  vi.useFakeTimers()
  const timedOut = call()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await vi.advanceTimersByTimeAsync(10000)
  expect(await timedOut).toMatchObject({ code: 'timeout', outcome: 'unconfirmed' })
})

it.each(['processing', 'completed'])('accepts confirmed %s status on idempotent replay', async status => {
  const { call, fetch } = setup()
  fetch.mockImplementation(async () => Response.json({ feedback: { ...receipt, status } }))
  expect(await call()).toMatchObject({ ok: true, status })
})
