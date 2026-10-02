import { VOICE_CAPABILITY_PATH, VOICE_SAMPLE_RATE, MAX_VOICE_DURATION_MS, MAX_VOICE_EVENT_BYTES, VOICE_TRANSCRIPT_MAX_CHARS, parseVoiceControl, validateVoiceFrameBytes, validateVoiceServerEvent, type VoiceServerEvent, type VoiceErrorCode } from '@lamplit/contracts/voice'
import { boundedRequest, isOperationAborted, isRequestTimeout, readResponseText } from './web-request'

export type VoiceEnvironment = Pick<Env, 'HOSTED_MODE' | 'PLATFORM_ORIGIN' | 'CHAT_INTERNAL_SECRET' | 'VOICE_API_KEY'> & { PLATFORM?: Pick<Fetcher, 'fetch'> }
export const VOICE_PROVIDER_URL = 'https://dashscope.aliyuncs.com/api-ws/v1/inference'
export const VOICE_MODEL = 'qwen-audio-3.1-asr-flash-streaming'
class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode) { super(code) }
}
const configError = () => new VoiceError('config_unavailable')
function validKey(value: unknown): value is string {
  // oxlint-disable-next-line no-control-regex -- keys must exclude control characters.
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value)
}
export async function voiceKey(env: VoiceEnvironment, instanceId: string | null, signal?: AbortSignal): Promise<string | null> {
  if (env.HOSTED_MODE !== 'true') return validKey(env.VOICE_API_KEY?.trim()) ? env.VOICE_API_KEY!.trim() : null
  if (!instanceId || !env.PLATFORM || !env.CHAT_INTERNAL_SECRET) throw configError()
  try {
    return await boundedRequest(env.PLATFORM.fetch.bind(env.PLATFORM), `${env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-voice/${instanceId}`, {
      headers: { 'x-lamplit-internal-secret': env.CHAT_INTERNAL_SECRET }, redirect: 'manual',
    }, { callerSignal: signal, timeoutMs: 5000, timeoutMessage: 'Voice settings timed out' }, async (response, requestSignal) => {
      if (!response.ok) throw configError()
      const data = JSON.parse(await readResponseText(response, 8192, requestSignal))
      if (data?.enabled === false) return null
      if (data?.enabled === true && validKey(data.apiKey)) return data.apiKey
      throw configError()
    })
  } catch (error) {
    if (isOperationAborted(error) || signal?.aborted) throw error
    if (isRequestTimeout(error)) throw new VoiceError('timeout')
    throw configError()
  }
}
/** One bounded relay per authenticated connection; no audio or transcript persistence. */
function relay(client: WebSocket, env: VoiceEnvironment, instanceId: string | null): void {
  const abort = new AbortController()
  const taskId = crypto.randomUUID()
  let upstream: WebSocket | undefined
  let terminal = false
  let ready = false
  let finishing = false
  let bytes = 0
  let chars = 0
  const sentences = new Map<number, string>()
  const unfinished = new Set<number>()
  let setupTimer: ReturnType<typeof setTimeout> | undefined
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  const close = (socket?: WebSocket) => { try { socket?.close(1000) } catch { /* Already closed. */ } }
  const end = (message?: VoiceServerEvent) => {
    if (terminal) return
    terminal = true
    clearTimeout(setupTimer); clearTimeout(lifetimeTimer); clearTimeout(finishTimer)
    abort.abort()
    try { if (message) client.send(JSON.stringify(message)) } catch { /* Disconnected client. */ }
    close(client); close(upstream)
    sentences.clear(); unfinished.clear()
  }
  const fail = (code: VoiceErrorCode = 'upstream_error') => end({ type: 'error', code })
  setupTimer = setTimeout(() => fail('timeout'), 15_000)
  client.addEventListener('close', () => end())
  client.addEventListener('error', () => end())
  client.addEventListener('message', event => {
    if (terminal) return
    try {
      if (typeof event.data === 'string') {
        const command = parseVoiceControl(event.data)
        if (command.type === 'cancel') return fail('cancelled')
        if (command.type !== 'finish' || !ready || finishing || !bytes) return fail('invalid_audio')
        finishing = true
        upstream!.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }))
        finishTimer = setTimeout(() => fail('timeout'), 20_000)
      } else {
        const data = event.data
        if (!(data instanceof ArrayBuffer) || !ready || finishing) return fail('invalid_audio')
        bytes = validateVoiceFrameBytes(data.byteLength, bytes)
        upstream!.send(data)
      }
    } catch { fail('invalid_audio') }
  })
  void (async () => {
    try {
      const key = await voiceKey(env, instanceId, abort.signal)
      if (terminal) return
      if (!key) return fail('voice_disabled')
      const response = await fetch(VOICE_PROVIDER_URL, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${key}` }, redirect: 'manual', signal: abort.signal })
      upstream = response.webSocket ?? undefined
      if (terminal) { if (upstream) { upstream.accept(); close(upstream) } return }
      if (response.status !== 101 || !upstream) {
        await response.body?.cancel()
        return fail(response.status === 401 || response.status === 403 ? 'invalid_key' : response.status === 429 ? 'rate_limited' : 'upstream_error')
      }
      upstream.accept()
      upstream.addEventListener('close', () => { if (!terminal) fail() })
      upstream.addEventListener('error', () => fail())
      upstream.addEventListener('message', event => {
        if (terminal) return
        try {
          if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > MAX_VOICE_EVENT_BYTES) return fail('transcript_invalid')
          const data = JSON.parse(event.data)
          if (!data?.header || data.header.task_id !== taskId || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return fail('transcript_invalid')
          switch (data.header.event) {
            case 'task-started':
              if (ready) return fail('transcript_invalid')
              ready = true
              clearTimeout(setupTimer)
              lifetimeTimer = setTimeout(() => fail('timeout'), MAX_VOICE_DURATION_MS + 20_000)
              client.send(JSON.stringify({ type: 'ready' }))
              break
            case 'result-generated': {
              if (!ready) return fail('transcript_invalid')
              const sentence = data.payload.output?.sentence
              if (!sentence || typeof sentence !== 'object') return fail('transcript_invalid')
              if (sentence.heartbeat === true) return
              if (typeof sentence.sentence_end !== 'boolean' || !Number.isSafeInteger(sentence.sentence_id) || sentence.sentence_id < 1 || typeof sentence.text !== 'string') return fail('transcript_invalid')
              if (!sentence.sentence_end) {
                if (!sentences.has(sentence.sentence_id)) unfinished.add(sentence.sentence_id)
                if (unfinished.size > VOICE_TRANSCRIPT_MAX_CHARS) return fail('transcript_invalid')
                return
              }
              unfinished.delete(sentence.sentence_id)
              const text = sentence.text
              if (!text.trim()) return fail('transcript_invalid')
              const length = Array.from(text).length
              chars += length - Array.from(sentences.get(sentence.sentence_id) ?? '').length
              if (chars > VOICE_TRANSCRIPT_MAX_CHARS) return fail('transcript_invalid')
              sentences.set(sentence.sentence_id, text)
              break
            }
            case 'task-finished': {
              if (!ready || !finishing || !sentences.size || unfinished.size) return fail('transcript_invalid')
              const text = [...sentences].sort(([a], [b]) => a - b).map(([, text]) => text).join('').trim()
              end(validateVoiceServerEvent({ type: 'result', text }))
              break
            }
            case 'task-failed': return fail()
            default: fail('transcript_invalid')
          }
        } catch { fail('transcript_invalid') }
      })
      upstream.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: VOICE_MODEL, parameters: { format: 'pcm', sample_rate: VOICE_SAMPLE_RATE, semantic_punctuation_enabled: false, max_sentence_silence: 400 }, input: {} } }))
    } catch (error) { if (!terminal) fail(error instanceof VoiceError ? error.code : 'upstream_error') }
  })()
}
export async function handleVoice(request: Request, env: VoiceEnvironment, instanceId: string | null): Promise<Response> {
  const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
  if (request.method !== 'GET') return respond({ code: 'method_not_allowed' }, 405)
  if (new URL(request.url).pathname === VOICE_CAPABILITY_PATH) {
    try { return respond({ available: Boolean(await voiceKey(env, instanceId, request.signal)) }) }
    catch (error) { return respond({ code: error instanceof VoiceError ? error.code : 'config_unavailable' }, 503) }
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ code: 'forbidden' }, 403)
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return respond({ code: 'upgrade_required' }, 426)
  const pair = new WebSocketPair()
  pair[1].binaryType = 'arraybuffer'
  pair[1].accept()
  relay(pair[1], env, instanceId)
  return new Response(null, { status: 101, webSocket: pair[0] })
}
