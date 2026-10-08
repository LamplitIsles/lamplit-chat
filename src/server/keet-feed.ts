import { type ChannelSource, parseChannelEvent } from './channel-events'
export type KeetSource = {
  kind: 'dm' | 'group'; destination: string; sender: string; text: string
  messageId: { deviceId: string; seq: number }; timestamp: number
  event?: ChannelSource; original?: string
  context: Array<{ sender: string; text: string }>
}

export type KeetFrame = {
  type: 'message'
  eventId: string
  sequence: number
  messageId: { deviceId: string; seq: number }
  timestamp: number
  destination: { groupName: string; kind: 'dm' | 'group' | 'broadcast' }
  senderLabel: string
  text: string
  addressing: { mentionsIdentity: boolean; replyToIdentity?: boolean; identityLabel?: string }
  replyTo?: { deviceId: string; seq: number }
  images?: Array<{ status: 'available' | 'unavailable'; mediaType: string; name?: string; ref?: string }>
  reactionContext?: Array<{ targetMessageId: KeetFrame['messageId']; targetText: string; emoji: string; externalCount: number }>
}

export function parseKeetFrame(value: unknown): KeetFrame {
  parseChannelEvent('keet', value, { webhookToken: '', aliases: [] })
  return value as KeetFrame
}

// Text intake does not download KFA media. This explanation alone is public.
export function keetDisplayText(frame: KeetFrame): string {
  return [frame.text, frame.images?.length ? '[Keet image unavailable in this Pi companion.]' : ''].filter(Boolean).join('\n')
}
