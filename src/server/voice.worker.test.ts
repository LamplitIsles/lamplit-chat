import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../server'
import { VOICE_MODEL, VOICE_PROVIDER_URL } from './voice'
const owners = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const auth = { authorization: `Basic ${btoa('owner:fixture-password-long-enough')}`, origin: 'https://chat.example', upgrade: 'websocket' }
const request = (headers: Record<string, string> = auth, path = 'stream') => new Request(`https://chat.example/api/voice/${path}`, { headers })
const localEnv = (extras: Partial<Omit<Env, 'PLATFORM'>> & { PLATFORM?: Pick<Fetcher, 'fetch'> } = {}) => new Proxy(env, { get: (target, key) => key in extras ? Reflect.get(extras, key) : Reflect.get(target, key) }) as Env
const hostedHeaders = (id = owners[0]) => ({ origin: 'https://chat.example', upgrade: 'websocket', 'x-lamplit-instance': id, 'x-lamplit-internal-secret': 'fixture-secret' })
function fakeProvider(autoStart = true) {
  let socket!: WebSocket, taskId = ''
  const frames: (string | ArrayBuffer)[] = []
  let closed = false
  const send = (event: string, payload: unknown = {}, id = taskId) => socket.send(JSON.stringify({ header: { event, task_id: id }, payload }))
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe(VOICE_PROVIDER_URL)
    expect(init?.redirect).toBe('manual')
    const pair = new WebSocketPair(); socket = pair[1]; socket.binaryType = 'arraybuffer'; socket.accept()
    socket.addEventListener('message', event => {
      frames.push(event.data)
      if (typeof event.data === 'string') {
        const data = JSON.parse(event.data)
        taskId = data.header.task_id
        if (data.header.action === 'run-task' && autoStart) send('task-started')
      }
    })
    socket.addEventListener('close', () => { closed = true })
    return new Response(null, { status: 101, webSocket: pair[0] })
  })
  return { provider, frames, send, sentence: (id: number, text: string, end = true) => send('result-generated', { output: { sentence: { sentence_id: id, text, sentence_end: end } } }), close: () => socket.close(1000), closed: () => closed }
}
async function connect(settings = localEnv({ VOICE_API_KEY: 'fixture-voice' }), headers: Record<string, string> = auth) {
  const response = await worker.fetch(request(headers), settings)
  expect(response.status).toBe(101)
  const socket = response.webSocket!; socket.accept()
  const messages: { type: string; text?: string; code?: string }[] = []
  socket.addEventListener('message', event => { messages.push(JSON.parse(event.data as string)) })
  return { socket, messages }
}
async function waitFor(fn: () => void) { await vi.waitFor(fn, { timeout: 3000, interval: 1 }) }
async function ready(client: Awaited<ReturnType<typeof connect>>) { await waitFor(() => expect(client.messages).toEqual([{ type: 'ready' }])) }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
describe('actual authenticated workerd streaming route', () => {
  it('gates PCM, streams before stop, flushes before finish, orders/deduplicates final sentences and closes', async () => {
    const fake = fakeProvider(); const client = await connect(); await ready(client)
    expect(JSON.parse(fake.frames[0] as string)).toEqual({ header: { action: 'run-task', task_id: expect.any(String), streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: VOICE_MODEL, parameters: { format: 'pcm', sample_rate: 16000, semantic_punctuation_enabled: false, max_sentence_silence: 400 }, input: {} } })
    expect(new Headers(fake.provider.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer fixture-voice')
    client.socket.send(new ArrayBuffer(3200))
    await waitFor(() => expect(fake.frames).toHaveLength(2))
    fake.sentence(1, 'intermediate', false); fake.sentence(2, 'second'); fake.sentence(1, 'first '); fake.sentence(1, 'first ')
    fake.send('result-generated', { output: { sentence: { heartbeat: true, sentence_id: 0 } } })
    client.socket.send(new ArrayBuffer(100)); client.socket.send('{"type":"finish"}')
    await waitFor(() => expect(fake.frames).toHaveLength(4))
    expect((fake.frames[2] as ArrayBuffer).byteLength).toBe(100)
    expect(JSON.parse(fake.frames[3] as string).header.action).toBe('finish-task')
    expect(client.messages).toEqual([{ type: 'ready' }])
    fake.send('task-finished')
    await waitFor(() => expect(client.messages).toEqual([{ type: 'ready' }, { type: 'result', text: 'first second' }]))
    await waitFor(() => expect(fake.closed()).toBe(true))
  })
  it('rejects an observed missing final but never reopens finalized IDs on late intermediate updates', async () => {
    for (const unfinished of [true, false]) {
      const fake = fakeProvider(); const client = await connect(); await ready(client)
      client.socket.send(new ArrayBuffer(2)); client.socket.send('{"type":"finish"}')
      await waitFor(() => expect(fake.frames).toHaveLength(3))
      fake.sentence(1, 'Completed first.')
      fake.sentence(unfinished ? 2 : 1, 'Intermediate text must never enter the result', false)
      if (!unfinished) fake.sentence(1, 'Duplicate late intermediate', false)
      fake.send('task-finished')
      await waitFor(() => expect(client.messages).toEqual([{ type: 'ready' }, unfinished
        ? { type: 'error', code: 'transcript_invalid' }
        : { type: 'result', text: 'Completed first.' }]))
      if (unfinished) expect(client.messages.filter(row => row.type === 'result')).toHaveLength(0)
      await waitFor(() => expect(fake.closed()).toBe(true))
      fake.provider.mockRestore()
    }
  })
  it('retains owner authentication and requires exact Origin before any paid call', async () => {
    const fake = fakeProvider()
    for (const headers of [{}, { ...auth, origin: '' }, { ...auth, origin: 'https://evil.example' }]) expect((await worker.fetch(request(headers), localEnv())).status).toBe('authorization' in headers ? 403 : 401)
    const settings = localEnv({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret' })
    for (const headers of [hostedHeaders('malformed'), { ...hostedHeaders(), 'x-lamplit-internal-secret': 'wrong' }]) expect((await worker.fetch(request(headers), settings)).status).toBe(403)
    expect(fake.provider).not.toHaveBeenCalled()
  })
  it('resolves fresh hosted keys per connection, capability is free, isolates owners and never falls back', async () => {
    let current: { enabled: boolean; apiKey?: string } = { enabled: true, apiKey: 'first-fixture' }
    const platform = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-lamplit-internal-secret')).toBe('fixture-secret')
      return Response.json((url instanceof Request ? url.url : url.toString()).endsWith(owners[0]) ? current : { enabled: false })
    })
    const settings = localEnv({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret', PLATFORM: { fetch: platform }, VOICE_API_KEY: 'never-fallback' })
    const fake = fakeProvider()
    expect(await (await worker.fetch(request(hostedHeaders(), 'capability'), settings)).json()).toEqual({ available: true })
    expect(fake.provider).not.toHaveBeenCalled()
    for (const key of ['first-fixture', 'changed-fixture']) {
      current.apiKey = key
      const client = await connect(settings, hostedHeaders()); await ready(client)
      expect(new Headers(fake.provider.mock.calls.at(-1)![1]?.headers).get('authorization')).toBe(`Bearer ${key}`)
      client.socket.send('{"type":"cancel"}'); await waitFor(() => expect(client.messages.at(-1)?.code).toBe('cancelled'))
    }
    current = { enabled: false }
    for (const headers of [hostedHeaders(), hostedHeaders(owners[1])]) {
      const client = await connect(settings, headers); await waitFor(() => expect(client.messages).toEqual([{ type: 'error', code: 'voice_disabled' }]))
    }
    platform.mockResolvedValue(new Response(null, { status: 404 }))
    const failed = await connect(settings, hostedHeaders()); await waitFor(() => expect(failed.messages[0]?.code).toBe('config_unavailable'))
    expect(fake.provider).toHaveBeenCalledTimes(2)
  })
  it('rejects pre-ready audio and malformed/frame/aggregate/command limits; no result after cancel', async () => {
    for (const input of [new ArrayBuffer(0), new ArrayBuffer(1), new ArrayBuffer(16386), '{', '{"type":"finish","extra":true}', ' '.repeat(129)]) {
      const fake = fakeProvider(); const client = await connect(); await ready(client); client.socket.send(input)
      await waitFor(() => expect(client.messages.at(-1)?.code).toBe('invalid_audio'))
      await waitFor(() => expect(fake.closed()).toBe(true)); fake.provider.mockRestore()
    }
    const fake = fakeProvider(false); const early = await connect(); await waitFor(() => expect(fake.frames).toHaveLength(1)); early.socket.send(new ArrayBuffer(2))
    await waitFor(() => expect(early.messages[0]?.code).toBe('invalid_audio')); fake.provider.mockRestore()
    const capped = fakeProvider(); const client = await connect(); await ready(client)
    for (let i = 0; i < 601; i++) client.socket.send(new ArrayBuffer(16000))
    await waitFor(() => expect(client.messages.at(-1)?.code).toBe('invalid_audio')); capped.provider.mockRestore()
    const cancelled = fakeProvider(); const take = await connect(); await ready(take); take.socket.send('{"type":"cancel"}')
    await waitFor(() => expect(take.messages.at(-1)?.code).toBe('cancelled')); await waitFor(() => expect(cancelled.closed()).toBe(true))
    expect(take.messages.filter(row => row.type === 'result')).toHaveLength(0)
  })
  it('rejects invalid/missing/oversized final, mismatched task, abnormal closure and provider frames', async () => {
    for (const mode of ['missing', 'oversized', 'task', 'frame', 'close', 'shape', 'failed']) {
      const fake = fakeProvider(); const client = await connect(); await ready(client); client.socket.send(new ArrayBuffer(2)); client.socket.send('{"type":"finish"}')
      await waitFor(() => expect(fake.frames).toHaveLength(3))
      if (mode === 'missing') fake.send('task-finished')
      if (mode === 'oversized') fake.sentence(1, 'a'.repeat(20001))
      if (mode === 'task') fake.send('task-finished', {}, 'wrong')
      if (mode === 'frame') fake.sentence(1, 'a'.repeat(128 * 1024))
      if (mode === 'close') fake.close()
      if (mode === 'shape') fake.send('result-generated', {})
      if (mode === 'failed') fake.send('task-failed')
      await waitFor(() => expect(client.messages.at(-1)?.code).toBe(mode === 'close' || mode === 'failed' ? 'upstream_error' : 'transcript_invalid'))
      expect(JSON.stringify(client.messages)).not.toContain('fixture-voice'); fake.provider.mockRestore()
    }
  })
  it('returns only safe HTTP upstream errors', async () => {
    for (const [status, code] of [[401, 'invalid_key'], [403, 'invalid_key'], [429, 'rate_limited'], [500, 'upstream_error'], [302, 'upstream_error']] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('PRIVATE', { status }))
      const client = await connect(); await waitFor(() => expect(client.messages).toEqual([{ type: 'error', code }]))
      vi.restoreAllMocks()
    }
  })
  it('bounds setup, finish, absolute ready lifetime and config; closes idle sockets deterministically', async () => {
    vi.useFakeTimers()
    const fake = fakeProvider(false); const client = await connect(); await vi.advanceTimersByTimeAsync(15_001)
    expect(client.messages.at(-1)?.code).toBe('timeout'); fake.provider.mockRestore()
    for (const finishing of [false, true]) {
      const upstream = fakeProvider(); const take = await connect()
      await vi.advanceTimersByTimeAsync(1)
      expect(take.messages[0]?.type).toBe('ready')
      if (finishing) { take.socket.send(new ArrayBuffer(2)); take.socket.send('{"type":"finish"}'); await vi.advanceTimersByTimeAsync(20_001) }
      else await vi.advanceTimersByTimeAsync(320_001)
      expect(take.messages.at(-1)?.code).toBe('timeout'); upstream.provider.mockRestore()
    }
    const platform = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    const pending = await connect(localEnv({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret', PLATFORM: { fetch: platform } }), hostedHeaders())
    await vi.advanceTimersByTimeAsync(5001)
    expect(pending.messages.at(-1)?.code).toBe('timeout')
  })
})
