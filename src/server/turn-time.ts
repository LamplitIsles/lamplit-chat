import type { Message } from '@earendil-works/pi-ai'

export const DEFAULT_USER_TIME_ZONE = 'Asia/Shanghai'

export function validUserTimeZone(value: string): string | undefined {
  if (!value || value !== value.trim() || /^[+-]/.test(value)) return undefined
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

export function formatTurnTime(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(timestamp)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value
  const offset = get('timeZoneName').replace('GMT', '') || '+00:00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${offset} (${timeZone})`
}

export function projectTurnTime(messages: readonly Message[], timeZone: string) {
  return messages.map((message) => {
    if (message.role !== 'user') return message
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
    return {
      ...message,
      content: [
        { type: 'text' as const, text: `[Host turn time: ${formatTurnTime(message.timestamp, timeZone)}]` },
        ...content,
      ],
    }
  })
}
