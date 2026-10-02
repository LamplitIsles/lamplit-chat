import { PANEL_LIMITS, type PanelBackend, type Reminder } from '@lamplit/contracts'
import type { RelationshipSnapshot, DiaryEntry } from '../shared/pi-contract'
import type { TimedWake } from '../shared/timed-wake'

interface PanelSource {
  sessionId(): string
  scope: string
  cursorSecret(): string
  relationship(input: { limit: number; before?: number }): Promise<RelationshipSnapshot>
  diaryList(): Promise<string[]>
  diaryRead(name: string): Promise<DiaryEntry | null>
  album: PanelBackend['album']
  reminders(): Promise<TimedWake[]>
}

// Authenticated continuations survive reconnects without a second content store.
export class PanelCursors {
  constructor(private readonly sessionId: () => string, private readonly secret: () => string) {}
  private async key() {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(this.secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  }
  async encode(method: string, value: string): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify([method, this.sessionId(), value]))
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await this.key(), data))
    return `${btoa(String.fromCharCode(...data))}.${btoa(String.fromCharCode(...signature))}`
  }
  async decode(method: string, cursor: string | null): Promise<string | undefined> {
    if (cursor === null) return undefined
    try {
      const parts = cursor.split('.')
      if (parts.length !== 2) throw new Error()
      const data = Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0))
      const signature = Uint8Array.from(atob(parts[1]), c => c.charCodeAt(0))
      if (!await crypto.subtle.verify('HMAC', await this.key(), signature, data)) throw new Error()
      const [storedMethod, sessionId, value] = JSON.parse(new TextDecoder().decode(data))
      if (storedMethod !== method || sessionId !== this.sessionId() || typeof value !== 'string') throw new Error()
      return value
    } catch { throw new Error('Invalid panel cursor') }
  }
}

export function createPiPanelBackend(source: PanelSource): PanelBackend {
  const cursors = new PanelCursors(() => source.sessionId(), () => source.cursorSecret())
  return {
    async relationship() {
      const snapshot = await source.relationship({ limit: 1 })
      return { scope: source.scope, current: snapshot.state }
    },
    async relationshipHistory(input) {
      const value = await cursors.decode('relationshipHistory', input.cursor)
      const before = value === undefined ? undefined : Number(value)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('Invalid relationship cursor')
      const snapshot = await source.relationship({ limit: PANEL_LIMITS.relationship, before })
      return { scope: source.scope, records: snapshot.records, predecessor: snapshot.predecessor ?? null,
        nextCursor: snapshot.nextBefore === undefined ? null : await cursors.encode('relationshipHistory', String(snapshot.nextBefore)) }
    },
    async diaryList(input) {
      const before = await cursors.decode('diaryList', input.cursor)
      const names = (await source.diaryList()).filter(name => before === undefined || name < before)
      const entries = names.slice(0, PANEL_LIMITS.diary)
      return { entries, nextCursor: names.length > entries.length ? await cursors.encode('diaryList', entries.at(-1)!) : null }
    },
    async diaryRead(input) {
      const entry = await source.diaryRead(input.name)
      return !entry ? { status: 'missing', name: input.name } : 'tooLarge' in entry ? { status: 'too-large', name: input.name } : { status: 'found', ...entry }
    },
    album: source.album,
    async reminders() {
      return { reminders: (await source.reminders()).map(wake => {
        const plan = wake.plan
        let schedule: Reminder['schedule']
        if (plan.type === 'once') schedule = { kind: 'once', at: Date.parse(plan.at) }
        else if (plan.type === 'interval') schedule = { kind: 'interval', everySeconds: plan.seconds, anchor: Date.parse(plan.anchor) }
        else {
          const [hour, minute] = plan.time.split(':').map(Number)
          schedule = plan.type === 'daily' ? { kind: 'daily', hour, minute, timeZone: plan.timeZone } : { kind: 'weekly', hour, minute, timeZone: plan.timeZone, weekday: plan.weekday }
        }
        return { id: wake.id, title: wake.title, message: wake.reminder, nextAt: Date.parse(wake.nextAt), schedule }
      }) }
    },
  }
}
