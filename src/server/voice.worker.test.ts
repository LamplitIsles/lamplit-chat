import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../server'
import { transcribeVoice, VOICE_BODY_MAX_BYTES, VOICE_PROVIDER_URL } from './voice'

const owners = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const audio = { audioBase64: 'YQ==', mediaType: 'audio/webm;codecs=opus', durationMs: 1000 }
const auth = { authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` }
const result = () => Response.json({ choices: [{ message: { content: '  Synthetic draft.  ' } }] })
const request = (path = 'transcribe', input: unknown = audio, headers: Record<string, string> = auth, signal?: AbortSignal) => new Request(`https://chat.example/api/voice/${path}`, { method: path === 'capability' ? 'GET' : 'POST', headers, signal, ...(path === 'capability' ? {} : { body: JSON.stringify(input) }) })
const localEnv = (extras: Partial<Omit<Env, 'PLATFORM'>> & { PLATFORM?: Pick<Fetcher, 'fetch'> } = {}) => new Proxy(env, { get: (target, key) => key in extras ? Reflect.get(extras, key) : Reflect.get(target, key) }) as Env
const hostedHeaders = (id = owners[0]) => ({ 'x-lamplit-instance': id, 'x-lamplit-internal-secret': 'fixture-secret' })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('voice through authenticated Worker fetch', () => {
  it('uses the fixed provider shape, returns clean text, and capability makes zero paid calls', async () => {
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      new Request(url, init)
      expect(url).toBe(VOICE_PROVIDER_URL)
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-voice')
      expect(JSON.parse(init?.body as string)).toEqual({ model: 'qwen3-asr-flash', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/webm;codecs=opus;base64,YQ==' } }] }], stream: false })
      return result()
    })
    const settings = localEnv({ VOICE_API_KEY: 'fixture-voice' })
    const capability = await worker.fetch(request('capability'), settings)
    expect(await capability.json()).toEqual({ available: true })
    expect(provider).not.toHaveBeenCalled()
    const response = await worker.fetch(request(), settings)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ text: 'Synthetic draft.' })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(await (await worker.fetch(request('capability'), localEnv({ VOICE_API_KEY: '' }))).json()).toEqual({ available: false })
    expect((await worker.fetch(request(), localEnv({ VOICE_API_KEY: '' }))).status).toBe(409)
  })

  it('resolves current hosted config per invocation, isolates owners, and never falls back', async () => {
    let current: { enabled: boolean; apiKey?: string } = { enabled: true, apiKey: 'first-fixture-key' }
    const platform = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      new Request(url, init)
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).get('x-lamplit-internal-secret')).toBe('fixture-secret')
      const address = url instanceof Request ? url.url : url.toString()
      expect(address).toContain('/internal/chat-voice/')
      return Response.json(address.endsWith(owners[0]) ? current : { enabled: false })
    })
    const settings = localEnv({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret', PLATFORM: { fetch: platform }, VOICE_API_KEY: 'never-fallback' })
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${current.apiKey}`)
      return result()
    })
    expect(await (await worker.fetch(request('capability', audio, hostedHeaders()), settings)).json()).toEqual({ available: true })
    expect(provider).not.toHaveBeenCalled()
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders()), settings)).status).toBe(200)
    current.apiKey = 'changed-fixture-key'
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders()), settings)).status).toBe(200)
    current = { enabled: false }
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders()), settings)).status).toBe(409)
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders(owners[1])), settings)).status).toBe(409)
    platform.mockResolvedValue(new Response(null, { status: 404 }))
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders()), settings)).status).toBe(503)
    platform.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))
    expect((await worker.fetch(request('capability', audio, hostedHeaders()), settings)).status).toBe(503)
    for (const data of [{}, { enabled: true }, { enabled: true, apiKey: ' bad ' }, { enabled: true, apiKey: 'bad\u0000key' }]) {
      platform.mockResolvedValue(Response.json(data))
      expect((await worker.fetch(request('transcribe', audio, hostedHeaders()), settings)).status).toBe(503)
    }
    expect(provider).toHaveBeenCalledTimes(2)
  })

  it('retains selfhost and hosted auth gates and rejects cross-origin mutation before provider', async () => {
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(result())
    expect((await worker.fetch(request('transcribe', audio, {}), env)).status).toBe(401)
    expect((await worker.fetch(request('transcribe', audio, { ...auth, origin: 'https://evil.example' }), env)).status).toBe(403)
    const settings = localEnv({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-secret' })
    expect((await worker.fetch(request('transcribe', audio, hostedHeaders('malformed')), settings)).status).toBe(403)
    expect((await worker.fetch(request('transcribe', audio, { ...hostedHeaders(), 'x-lamplit-internal-secret': 'wrong' }), settings)).status).toBe(403)
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects malformed audio and bounds streamed JSON independently of Content-Length', async () => {
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(result())
    const settings = localEnv({ VOICE_API_KEY: 'fixture' })
    for (const input of [null, {}, { ...audio, audioBase64: 'YR==' }, { ...audio, audioBase64: 'YQ' }, { ...audio, audioBase64: '' }, { ...audio, mediaType: 'text/plain' }, { ...audio, durationMs: 0 }, { ...audio, durationMs: 300001 }]) {
      const response = await worker.fetch(request('transcribe', input), settings)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_audio' })
    }
    const oversizedAudio = await worker.fetch(request('transcribe', { ...audio, audioBase64: 'AAAA'.repeat(2_500_000) }), settings)
    expect(oversizedAudio.status).toBe(413)
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(VOICE_BODY_MAX_BYTES + 1)); controller.close() } })
    const streamRequest = new Request('https://chat.example/api/voice/transcribe', { method: 'POST', headers: { ...auth, 'content-length': '1' }, body })
    expect((await worker.fetch(streamRequest, settings)).status).toBe(413)
    expect((await worker.fetch(new Request('https://chat.example/api/voice/transcribe', { method: 'POST', headers: auth, body: '{' }), settings)).status).toBe(400)
    expect(provider).not.toHaveBeenCalled()
  })

  it('returns safe provider categories, rejects redirects, malformed and oversized transcripts', async () => {
    const provider = vi.spyOn(globalThis, 'fetch')
    const settings = localEnv({ VOICE_API_KEY: 'PRIVATE-fixture' })
    for (const [status, code] of [[401, 'invalid_key'], [403, 'invalid_key'], [429, 'rate_limited'], [500, 'upstream_error'], [302, 'upstream_error']] as const) {
      provider.mockResolvedValue(new Response('PRIVATE-upstream', { status }))
      const response = await worker.fetch(request(), settings)
      expect(response.status).toBe(502)
      const data = await response.json()
      expect(data).toMatchObject({ code })
      expect(JSON.stringify(data)).not.toContain('PRIVATE')
    }
    for (const payload of ['{', JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: ' ' } }] }), JSON.stringify({ choices: [{ message: { content: 'a'.repeat(20001) } }] }), 'a'.repeat(128 * 1024 + 1)]) {
      provider.mockResolvedValue(new Response(payload))
      expect(await (await worker.fetch(request(), settings)).json()).toMatchObject({ code: 'transcript_invalid' })
    }
  })

  it('cancels before submission and during provider/config fetch, with total and config deadlines', async () => {
    vi.useFakeTimers()
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }) }))
    const controller = new AbortController()
    controller.abort()
    await expect(transcribeVoice({ VOICE_API_KEY: 'fixture' }, null, audio, controller.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(provider).not.toHaveBeenCalled()
    const running = new AbortController()
    const cancelled = transcribeVoice({ VOICE_API_KEY: 'fixture' }, null, audio, running.signal)
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1))
    running.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    const deadline = transcribeVoice({ VOICE_API_KEY: 'fixture' }, null, audio)
    const timeout = expect(deadline).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(60_001)
    await timeout
    const config = transcribeVoice({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture', PLATFORM: { fetch: provider } }, owners[0], audio)
    const configTimeout = expect(config).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5001)
    await configTimeout
    const configAbort = new AbortController()
    const pendingConfig = transcribeVoice({ HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture', PLATFORM: { fetch: provider } }, owners[0], audio, configAbort.signal)
    const configCancelled = expect(pendingConfig).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(4))
    configAbort.abort()
    await configCancelled
  })
})
