export type KeetSource = {
  kind: 'dm' | 'group'; destination: string; sender: string; text: string
  messageId: { deviceId: string; seq: number }; timestamp: number
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
  trigger?: 'dm' | 'mention' | 'label' | 'reply'
  replyTo?: { deviceId: string; seq: number }
  images?: Array<{ status: 'available' | 'unavailable'; mediaType: string; name?: string; ref?: string }>
  reactionContext?: Array<{ targetMessageId: KeetFrame['messageId']; targetText: string; emoji: string; externalCount: number }>
}

const id = (value: unknown): value is KeetFrame['messageId'] => {
  const item = value as KeetFrame['messageId'] | null
  return !!item && typeof item === 'object' && typeof item.deviceId === 'string' && !!item.deviceId.trim() && Array.from(item.deviceId).length <= 512 && Number.isSafeInteger(item.seq) && item.seq >= 0
}
const name = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && Array.from(value).length <= 512 && !/[\r\n\u2028\u2029]/.test(value)

export function parseKeetFrame(value: unknown): KeetFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Keet frame.')
  const frame = value as KeetFrame
  const keys = Object.keys(frame)
  if (keys.some((key) => !['type', 'eventId', 'sequence', 'messageId', 'timestamp', 'destination', 'senderLabel', 'text', 'trigger', 'replyTo', 'images', 'reactionContext'].includes(key)) ||
      Object.keys(frame.messageId ?? {}).some((key) => !['deviceId', 'seq'].includes(key)) ||
      Object.keys(frame.destination ?? {}).some((key) => !['groupName', 'kind'].includes(key))) throw new Error('Invalid Keet frame.')
  if (frame.type !== 'message' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(frame.eventId) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || !id(frame.messageId) ||
      !Number.isSafeInteger(frame.timestamp) || !frame.destination || !name(frame.destination.groupName) ||
      !['dm', 'group', 'broadcast'].includes(frame.destination.kind) || !name(frame.senderLabel) ||
      typeof frame.text !== 'string' || Array.from(frame.text).length > 16_000 || (!frame.text.trim() && !frame.images?.length) ||
      (frame.trigger !== undefined && !['dm', 'mention', 'label', 'reply'].includes(frame.trigger)) ||
      (frame.destination.kind === 'dm' && frame.trigger !== 'dm') ||
      (frame.destination.kind !== 'dm' && frame.trigger === 'dm') ||
      (frame.trigger && frame.trigger !== 'dm' && frame.destination.kind !== 'group') ||
      (frame.replyTo !== undefined && !id(frame.replyTo)) ||
      (frame.images !== undefined && (!Array.isArray(frame.images) || !frame.images.length || frame.images.length > 16 || frame.images.some((image) => !image || typeof image !== 'object' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType) || (image.name !== undefined && !name(image.name)) || (image.status === 'available' ? typeof image.ref !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(png|jpg|webp|gif)$/.test(image.ref) : image.status !== 'unavailable' || image.ref !== undefined)))) ||
      (frame.reactionContext !== undefined && (!frame.trigger || frame.destination.kind === 'broadcast' || !Array.isArray(frame.reactionContext) || !frame.reactionContext.length || frame.reactionContext.length > 16 || frame.reactionContext.some((item) => !item || !id(item.targetMessageId) || !item.targetText?.trim() || Array.from(item.targetText).length > 48 || typeof item.emoji !== 'string' || !item.emoji || !Number.isSafeInteger(item.externalCount) || item.externalCount < 1 || item.externalCount > 100_000)))) throw new Error('Invalid Keet frame.')
  return frame
}

export function keetIdentity(frame: KeetFrame): string {
  return frame.eventId
}

export function keetSource(frame: KeetFrame, context: KeetSource['context']): KeetSource {
  return {
    kind: frame.destination.kind as 'dm' | 'group', destination: frame.destination.groupName,
    sender: frame.senderLabel, text: frame.text, messageId: frame.messageId, timestamp: frame.timestamp, context,
  }
}

export function keetPrompt(frame: KeetFrame, context: KeetSource['context']): string {
  const header = `[Keet ${frame.destination.kind === 'dm' ? 'DM' : 'Group'}: ${frame.destination.groupName}; sender: ${frame.senderLabel}; message: ${frame.messageId.deviceId}:${frame.messageId.seq}]`
  const previous = context.length ? `\nRecent group context:\n${context.map((item) => `${item.sender}: ${item.text}`).join('\n')}` : ''
  const reactions = frame.reactionContext?.length
    ? `\nRecent reactions to your messages:\n${frame.reactionContext.map((item) => `- ${item.emoji} ×${item.externalCount} on "${item.targetText}" (message: ${item.targetMessageId.deviceId}:${item.targetMessageId.seq})`).join('\n')}`
    : ''
  return `${header}\n${keetDisplayText(frame)}${previous}${reactions}`.slice(0, 40_000)
}

// Legacy Pi does not download KFA media. This explanation alone is public.
export function keetDisplayText(frame: KeetFrame): string {
  return [frame.text, frame.images?.length ? '[Keet image unavailable in this Pi companion.]' : ''].filter(Boolean).join('\n')
}
