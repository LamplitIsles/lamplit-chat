import { PAGE_SIZE } from '@lamplit/contracts'
import type { Conversation, Cursor, EntryRecord, EntryId, Harness } from '@earendil-works/pi-durable'
import type { ArchiveEntry } from './conversation-archive'
import type { PiSessionStorage } from './pi-session-storage'

// Each read admits at most 30 native records, including invisible records. An
// empty visible page with a continuation is deliberately not end-of-history.
export const HISTORY_WORK_LIMIT = PAGE_SIZE
export type HistoryPage = { entries: ArchiveEntry[]; before: string | null; leafId: string | null; revision: number }
type Position = { sessionId: string; conversationId: number; maxEntryId: number; cursor: Cursor | null; entryId: number | null; partEnd: number; archiveBefore: number | null; archiveMax: number }
type Context = Parameters<Harness['close']>[0]
export class NativeHistory {
  constructor(private readonly store: PiSessionStorage, private readonly lane: Conversation, private readonly context: Context) {}
  private async signature(payload: string): Promise<string> {
    let secret = this.store.getSetting<string>('historyCursorSecret')
    if (!secret) { secret = crypto.randomUUID(); this.store.setSetting('historyCursorSecret', secret) }
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
    return btoa(String.fromCharCode(...signature)).replace(/=+$/, '')
  }
  private async encode(position: Position): Promise<string> {
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([position.sessionId, position.conversationId, position.maxEntryId, position.cursor, position.entryId, position.partEnd, position.archiveBefore, position.archiveMax]))))
    const token = `${payload}.${await this.signature(payload)}`
    if (token.length > 300) throw new Error('History continuation exceeds contract limit')
    return token
  }
  private async decode(token: string): Promise<Position> {
    try {
      if (token.length > 300) throw new Error()
      const [payload, signature, extra] = token.split('.')
      if (!payload || !signature || extra !== undefined || signature !== await this.signature(payload)) throw new Error()
      const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), character => character.charCodeAt(0))))
      if (!Array.isArray(p) || p.length !== 8 || p[0] !== this.store.getMetadataSync().id || p[1] !== this.lane.id || !Number.isSafeInteger(p[2]) || p[2] < 0 || (p[3] !== null && (typeof p[3] !== 'object' || Array.isArray(p[3]))) || (p[4] !== null && (!Number.isSafeInteger(p[4]) || p[4] < 1 || p[4] > p[2])) || !Number.isSafeInteger(p[5]) || p[5] < 0 || (p[6] !== null && (!Number.isSafeInteger(p[6]) || p[6] < 0)) || !Number.isSafeInteger(p[7]) || p[7] < 1) throw new Error()
      return { sessionId: p[0], conversationId: p[1], maxEntryId: p[2], cursor: p[3], entryId: p[4], partEnd: p[5], archiveBefore: p[6], archiveMax: p[7] }
    } catch { throw new Error('Invalid history cursor') }
  }
  async readNative(id: number): Promise<EntryRecord | undefined> {
    return (await this.lane.entries({ minEntryId: id as EntryId, maxEntryId: id as EntryId }, 1, undefined, this.context)).items[0]
  }
  async page(before?: string, limit = PAGE_SIZE): Promise<HistoryPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new Error('Invalid page limit')
    const first = before ? undefined : await this.lane.entries({}, 1, undefined, this.context)
    const p: Position = before ? await this.decode(before) : { sessionId: this.store.getMetadataSync().id, conversationId: this.lane.id, maxEntryId: first?.items[0]?.id ?? 0, cursor: null, entryId: null, partEnd: 0, archiveBefore: null, archiveMax: this.store.archiveMaxSeq() + 1 }
    if (before && p.maxEntryId && !await this.readNative(p.maxEntryId)) throw new Error('Stale history cursor')
    const entries: ArchiveEntry[] = []
    let work = 0, finished = p.maxEntryId === 0 && p.entryId === null
    if (p.archiveBefore === null) while (!finished && work++ < HISTORY_WORK_LIMIT && entries.length < limit) {
      const page = p.entryId === null ? await this.lane.entries({ maxEntryId: p.maxEntryId as EntryId }, 1, p.cursor ?? undefined, this.context) : undefined
      const record = p.entryId === null ? page?.items[0] : await this.readNative(p.entryId)
      if (!record) { if (p.entryId) throw new Error('Stale history cursor'); finished = true; break }
      if (page) p.cursor = page.next ?? null
      const count = this.parts(record)
      const end = p.partEnd || count
      if (end > count) throw new Error('Stale history cursor')
      const start = Math.max(0, end - (limit - entries.length))
      entries.unshift(...this.project(record, start, end - start))
      p.entryId = start ? record.id : null; p.partEnd = start
      finished = !p.entryId && !p.cursor
    }
    if (finished && p.archiveBefore === null) p.archiveBefore = p.archiveMax
    // Source-only archive is independent of native context, and remains readable.
    // Conversion mappings suppress duplicate main-path source records. Existing
    // native mirrors are checked by exact immutable native ID, never body/time.
    if (p.archiveBefore !== null && entries.length < limit) {
      const rows = this.store.archivePage(p.archiveBefore, limit - entries.length)
      for (const entry of rows) {
        const nativeId = this.store.nativeId(entry.id) ?? nativeNumber(entry.id)
        if (nativeId === undefined || !await this.readNative(nativeId)) entries.unshift(entry)
      }
      p.archiveBefore = rows.at(-1)?.seq ?? 0
    }
    return { entries, before: p.archiveBefore === 0 ? null : await this.encode(p), leafId: p.maxEntryId ? this.store.sourceId(p.maxEntryId) : null, revision: p.maxEntryId }
  }
  parts(record: EntryRecord): number {
    if (record.kind === 'pi.system' || record.kind === 'pi.reset') return 0
    if (record.kind === 'lamplit.converted-context' || record.kind === 'lamplit.history' || record.kind === 'pi.compaction') return 1
    return record.model?.length ?? (this.store.nativeId(this.store.sourceId(record.id)) !== undefined ? 1 : 0)
  }
  project(record: EntryRecord, from = 0, limit = PAGE_SIZE): ArchiveEntry[] {
    const source = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data.sourceId : undefined
    const sourceId = typeof source === 'string' ? source : this.store.sourceId(record.id)
    const metadata = this.store.archiveMetadata(sourceId)
    const original = this.store.nativeId(sourceId) !== undefined ? this.store.getEntrySync(sourceId) : undefined
    if (record.kind === 'lamplit.converted-context') return original ? [original] : []
    if (record.kind === 'lamplit.history' && original) return [original]
    if (record.kind === 'pi.system' || record.kind === 'pi.reset') return []
    if (record.kind === 'pi.compaction') {
      const message = record.model?.[0]
      const summary = message?.content
      return [{ id: sourceId, parentId: null, seq: record.id, timestamp: message && 'timestamp' in message ? message.timestamp : 0, type: 'compaction', summary: typeof summary === 'string' ? summary : Array.isArray(summary) ? summary.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '', tokensBefore: 0 }]
    }
    if (!record.model?.length) return original ? [original] : []
    return record.model.slice(from, from + limit).map((message, offset) => { const index = from + offset; return ({ id: index ? `${sourceId}:${index}` : sourceId, parentId: index ? sourceId : metadata?.parentId ?? null, seq: metadata?.seq ?? record.id, timestamp: metadata?.timestamp ?? ('timestamp' in message ? message.timestamp : 0), type: 'message', message }); })
  }
  async entry(id: string): Promise<ArchiveEntry | undefined> {
    const mapped = this.store.nativeId(id)
    const match = /^native:(\d+)(?::(\d+))?$/.exec(id)
    const nativeId = mapped ?? (match ? Number(match[1]) : undefined)
    if (nativeId !== undefined) {
      const record = await this.readNative(nativeId)
      if (record) return this.project(record, match?.[2] ? Number(match[2]) : 0, 1).find(entry => entry.id === id)
    }
    return this.store.getEntrySync(id)
  }
}
function nativeNumber(id: string): number | undefined {
  const m = /^native:(\d+)$/.exec(id)
  return m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : undefined
}
