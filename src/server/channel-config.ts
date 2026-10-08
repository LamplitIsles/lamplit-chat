import { timingSafeEqual } from 'node:crypto'
import { boundedRequest, readResponseText } from './web-request'
export type Channel = 'keet' | 'matrix'
export type ChannelConfig = { webhookToken: string; aliases: string[]; selfUserId?: string }
export type Channels = Partial<Record<Channel, ChannelConfig>>
export class ChannelError extends Error {
  constructor(readonly status: number) { super(status === 503 ? 'Channel unavailable' : status === 409 ? 'Conflicting event' : status === 413 ? 'Payload too large' : 'Invalid channel request') }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError(400)
  return value as Record<string, unknown>
}
export function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ChannelError(400)
}
function text(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length < min || value.length > max) throw new ChannelError(503)
  return value
}
function token(value: unknown, min: number, max: number): string {
  const result = text(value, min, max)
  if (!/^[\x21-\x7e]+$/.test(result)) throw new ChannelError(503)
  return result
}
export function parseChannels(value: unknown): Channels {
  const data = object(value)
  only(data, ['keet', 'matrix'])
  const result: Channels = {}
  const tokens = new Set<string>()
  for (const name of ['keet', 'matrix'] as const) {
    if (!Object.hasOwn(data, name)) continue
    const config = object(data[name]); only(config, name === 'matrix' ? ['webhookToken', 'aliases', 'selfUserId'] : ['webhookToken', 'aliases'])
    let selfUserId: string | undefined
    if (name === 'matrix') {
      selfUserId = text(config.selfUserId, 1, 255)
      if (!/^@[^:\s]+:[^\s]+$/.test(selfUserId)) throw new ChannelError(503)
    }
    const aliases = config.aliases ?? []
    if (!Array.isArray(aliases) || aliases.length > 16) throw new ChannelError(503)
    const webhookToken = token(config.webhookToken, 16, 512)
    if (tokens.has(webhookToken)) throw new ChannelError(503)
    tokens.add(webhookToken)
    result[name] = { webhookToken, aliases: aliases.map(value => text(value, 1, 128)), ...(selfUserId ? { selfUserId } : {}) }
  }
  return result
}
export async function channelConfig(env: Env, instanceId: string | null): Promise<Channels> {
  try {
    if (!instanceId) return env.CHAT_INTEGRATIONS === undefined ? {} : parseChannels(JSON.parse(env.CHAT_INTEGRATIONS))
    if (!env.PLATFORM || !env.CHAT_INTERNAL_SECRET) throw new ChannelError(503)
    return await boundedRequest(env.PLATFORM.fetch.bind(env.PLATFORM), `${env.PLATFORM_ORIGIN ?? 'https://app.lamplit.run'}/internal/chat-integrations/${instanceId}`, {
      headers: { 'x-lamplit-internal-secret': env.CHAT_INTERNAL_SECRET }, redirect: 'manual',
    }, { timeoutMs: 5000, timeoutMessage: 'Integration settings timed out' }, async (response, signal) => {
      if (!response.ok) { await response.body?.cancel(); throw new ChannelError(503) }
      return parseChannels(JSON.parse(await readResponseText(response, 32 * 1024, signal)))
    })
  } catch { throw new ChannelError(503) }
}
export async function boundedBody(request: Request | Response, limit = 112 * 1024): Promise<string> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new ChannelError(413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ChannelError(400) }
}
export async function bearerMatches(header: string | null, token: string): Promise<boolean> {
  if (!header || !/^Bearer /i.test(header)) return false
  const hash = async (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const [a, b] = await Promise.all([hash(header.slice(7)), hash(token)])
  return timingSafeEqual(new Uint8Array(a), new Uint8Array(b))
}

/** JSON member ordering does not change an immutable event's content. */
export function eventIdentity(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item
  return JSON.stringify(canonical(value))
}
