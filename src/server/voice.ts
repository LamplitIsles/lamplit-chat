import { isCanonicalBase64, MAX_VOICE_DATA_URL_BYTES, MAX_VOICE_DURATION_MS, normalizeVoiceMediaType, voiceDataUrlPrefix } from '../../frontend/src/lib/companion/voice-contract'
import { boundedRequest, isOperationAborted, isRequestTimeout, readResponseText, ResponseBodyLimitError } from './web-request'

export type VoiceEnvironment = Pick<Env, 'HOSTED_MODE' | 'PLATFORM_ORIGIN' | 'CHAT_INTERNAL_SECRET' | 'VOICE_API_KEY'> & { PLATFORM?: Pick<Fetcher, 'fetch'> }
export const VOICE_PROVIDER_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
export const VOICE_BODY_MAX_BYTES = 10_001_024
class VoiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}
const configError = () => new VoiceError('config_unavailable', 'Voice settings unavailable. Try again later.', 503)
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
    if (isRequestTimeout(error)) throw new VoiceError("timeout", "Voice settings timed out. Please retry.", 504)
    throw configError()
  }
}
function audioDataUrl(input: unknown): string {
  const invalid = () => new VoiceError('invalid_audio', 'Provide valid audio of up to five minutes.', 400)
  if (!input || typeof input !== 'object') throw invalid()
  const { audioBase64, mediaType, durationMs } = input as Record<string, unknown>
  const mime = normalizeVoiceMediaType(mediaType)
  if (!mime || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_VOICE_DURATION_MS || !isCanonicalBase64(audioBase64)) throw invalid()
  const prefix = voiceDataUrlPrefix(mime)!
  if (prefix.length + audioBase64.length > MAX_VOICE_DATA_URL_BYTES) throw new VoiceError('invalid_audio', 'Audio exceeds the 10 MB data URL limit.', 413)
  return prefix + audioBase64
}
/** One executor shared by chat and the platform's authenticated chat proxy. */
export async function transcribeVoice(env: VoiceEnvironment, instanceId: string | null, input: unknown, signal?: AbortSignal): Promise<{ text: string }> {
  const data = audioDataUrl(input)
  const controller = new AbortController()
  let expired = false
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => { expired = true; abort() }, 60_000)
  const started = Date.now()
  try {
    const key = await voiceKey(env, instanceId, controller.signal)
    if (!key) throw new VoiceError('voice_disabled', 'Voice input is not configured.', 409)
    return await boundedRequest(undefined, VOICE_PROVIDER_URL, {
      method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-asr-flash', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }], stream: false }),
    }, { callerSignal: controller.signal, timeoutMs: Math.max(1, 60_000 - (Date.now() - started)), timeoutMessage: 'Recognition timed out' }, async (response, requestSignal) => {
      if (!response.ok) {
        await response.body?.cancel()
        throw new VoiceError(response.status === 401 || response.status === 403 ? 'invalid_key' : response.status === 429 ? 'rate_limited' : 'upstream_error', 'Recognition unavailable. Check voice settings or try again later.', 502)
      }
      let raw
      try { raw = JSON.parse(await readResponseText(response, 128 * 1024, requestSignal)) }
      catch (error) { if (requestSignal.aborted) throw error; throw new VoiceError('transcript_invalid', 'Recognition returned an invalid result. Please retry.', 502) }
      const text = raw?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim() || Array.from(text.trim()).length > 20_000) throw new VoiceError('transcript_invalid', 'Recognition returned an invalid result. Please retry.', 502)
      return { text: text.trim() }
    })
  } catch (error) {
    if (expired || isRequestTimeout(error)) throw new VoiceError('timeout', 'Recognition timed out. Please retry.', 504)
    if (signal?.aborted || isOperationAborted(error)) throw new VoiceError('cancelled', 'Recognition cancelled.', 499)
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export async function handleVoice(request: Request, env: VoiceEnvironment, instanceId: string | null): Promise<Response> {
  const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
  const capability = new URL(request.url).pathname === '/api/voice/capability'
  if (request.method !== (capability ? 'GET' : 'POST')) return respond({ code: 'method_not_allowed', error: 'Method not allowed' }, 405)
  if (!capability && request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return respond({ code: 'forbidden', error: 'Forbidden' }, 403)
  try {
    if (capability) return respond({ available: Boolean(await voiceKey(env, instanceId, request.signal)) })
    let input
    try { input = JSON.parse(await readResponseText(request, VOICE_BODY_MAX_BYTES, request.signal)) }
    catch (error) {
      if (request.signal.aborted) throw new VoiceError('cancelled', 'Recognition cancelled.', 499)
      throw new VoiceError('invalid_audio', 'Provide bounded audio JSON.', error instanceof ResponseBodyLimitError ? 413 : 400)
    }
    return respond(await transcribeVoice(env, instanceId, input, request.signal))
  } catch (error) {
    const failure = error instanceof VoiceError ? error : new VoiceError('upstream_error', 'Recognition unavailable. Please retry.', 502)
    return respond({ code: failure.code, error: failure.message }, failure.status)
  }
}
