import { ChannelError, object, only, type Channel, type ChannelConfig } from './channel-config'
import type { ChannelSource } from '../shared/pi-contract'
export type KeetId = { deviceId: string; seq: number }
export type Reaction = { targetMessageId: KeetId; targetText: string; emoji: string; externalCount: number }
export type ChannelEvent = { key: string; room: string; source: ChannelSource; trigger: boolean; buffer: boolean; reactions: Reaction[] }
const invalid = (): never => { throw new ChannelError(400) }
function string(value: unknown, max: number, blank = false, points = false): string {
  if (typeof value !== 'string' || (!blank && !value.trim()) || (points ? Array.from(value).length : value.length) > max) invalid()
  return value as string
}
function name(value: unknown): string {
  const s = string(value, 512, false, true)
  if (s !== s.trim() || /[\r\n\u2028\u2029]/.test(s)) invalid()
  return s
}
function integer(value: unknown, min?: number): number {
  if (!Number.isSafeInteger(value) || (min !== undefined && (value as number) < min)) invalid()
  return value as number
}
function id(value: unknown): KeetId {
  const data = object(value); only(data, ['deviceId', 'seq'])
  return { deviceId: string(data.deviceId, 512, false, true), seq: integer(data.seq, 0) }
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value as boolean }
export function parseChannelEvent(channel: Channel, value: unknown, config: ChannelConfig, self?: string): ChannelEvent {
  const data = object(value)
  if (data.type !== 'message') invalid()
  if (channel === 'matrix') {
    only(data, ['type', 'room_id', 'event_id', 'sender_id', 'sender_display_name', 'body', 'mentions', 'reply_to_event_id', 'timestamp', 'truncated'])
    const room = string(data.room_id, 255), event = string(data.event_id, 255), sender = string(data.sender_id, 255)
    const label = string(data.sender_display_name, 255, true), body = string(data.body, 16000, true)
    if (!Array.isArray(data.mentions) || data.mentions.length > 100) invalid()
    const mentions = (data.mentions as unknown[]).map(value => string(value, 255, true))
    const replyTo = data.reply_to_event_id === undefined ? undefined : string(data.reply_to_event_id, 255, true)
    const timestamp = integer(data.timestamp), truncated = boolean(data.truncated)
    if (!self) throw new ChannelError(503)
    const eligible = sender !== self && !!body.trim()
    return { key: JSON.stringify([room, event]), room, trigger: eligible && (mentions.includes(self) || config.aliases.some(alias => body.includes(alias))), buffer: eligible,
      source: { channel, destination: room, sender: label || sender, senderId: sender, eventId: event, text: body, timestamp, replyTo, truncated }, reactions: [] }
  }
  only(data, ['type', 'eventId', 'sequence', 'messageId', 'timestamp', 'destination', 'senderLabel', 'text', 'replyTo', 'addressing', 'images', 'reactionContext'])
  const event = string(data.eventId, 36)
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(event)) invalid()
  const sequence = integer(data.sequence, 1), messageId = id(data.messageId), timestamp = integer(data.timestamp)
  const destination = object(data.destination); only(destination, ['groupName', 'kind'])
  const room = name(destination.groupName), kind = destination.kind
  if (kind !== 'dm' && kind !== 'group' && kind !== 'broadcast') invalid()
  const sender = name(data.senderLabel), body = string(data.text, 16000, true, true)
  const replyTo = data.replyTo === undefined ? undefined : id(data.replyTo)
  const addressing = object(data.addressing); only(addressing, ['mentionsIdentity', 'replyToIdentity', 'identityLabel'])
  const mention = boolean(addressing.mentionsIdentity)
  const ownReply = addressing.replyToIdentity === undefined ? undefined : boolean(addressing.replyToIdentity)
  if (ownReply !== undefined && !replyTo) invalid()
  const label = addressing.identityLabel === undefined ? undefined : name(addressing.identityLabel)
  if (data.images !== undefined) {
    if (!Array.isArray(data.images) || !data.images.length || data.images.length > 16) invalid()
    for (const item of data.images as unknown[]) {
      const image = object(item); only(image, ['status', 'mediaType', 'name', 'ref'])
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType as string)) invalid()
      if (image.name !== undefined) name(image.name)
      if (image.status === 'available') { if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(png|jpg|webp|gif)$/.test(string(image.ref, 41))) invalid() }
      else if (image.status !== 'unavailable' || image.ref !== undefined) invalid()
    }
  }
  if (!body.trim() && !data.images) invalid()
  const reactions: Reaction[] = []
  if (data.reactionContext !== undefined) {
    if (kind === 'broadcast' || !Array.isArray(data.reactionContext) || !data.reactionContext.length || data.reactionContext.length > 16) invalid()
    for (const value of data.reactionContext as unknown[]) {
      const r = object(value); only(r, ['targetMessageId', 'targetText', 'emoji', 'externalCount'])
      const targetMessageId = id(r.targetMessageId)
      if (Array.from(targetMessageId.deviceId).length > 128) invalid()
      const emoji = string(r.emoji, 66, false, true)
      if (new TextEncoder().encode(emoji).length > 258 || !(/^:(?:[a-z0-9][a-z0-9_+-]*|[+-][0-9]+):$/.test(emoji) || new RegExp('^\\p{RGI_Emoji}$', 'v').test(emoji))) invalid()
      const externalCount = integer(r.externalCount, 1)
      if (externalCount > 100000) invalid()
      reactions.push({ targetMessageId, emoji, externalCount, targetText: string(r.targetText, 48, false, true) })
    }
  }
  return { key: event, room: JSON.stringify([kind, room]), trigger: !!body.trim() && (kind === 'dm' || (kind === 'group' && (mention || !!(label && body.includes(label)) || ownReply === true || config.aliases.some(alias => body.includes(alias))))), buffer: kind === 'group' && !!body.trim(), reactions,
    source: { channel, destination: room, destinationKind: kind as 'dm' | 'group' | 'broadcast', sender, text: body, timestamp, eventId: event, messageId, sequence, replyTo } }
}
