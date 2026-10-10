import { keetDisplayText, type KeetFrame, type KeetSource } from './keet-feed'
import { parseChannelEvent, type ChannelEvent, type Reaction } from './channel-events'
import { ChannelError, eventIdentity, type Channel } from './channel-config'

export type InboundSource = KeetSource | { kind: 'matrix'; destination: string; sender: string; text: string; timestamp: number; context: KeetSource['context']; event: ChannelEvent['source']; original: string }
import { nativeSearchNode } from './conversation-search'
import { occurrenceKey, type TimedWake, type WakeSource } from '../shared/timed-wake'
import { nextWake } from './timed-wake'
import { ConversationArchive, type ArchiveEntry as Entry } from './conversation-archive'
import type { ConversationPhoto, ConversationPhotoPage, SessionIndexEvent, SessionLineage } from '../shared/pi-contract'
import { submissionIdentity, type ChatAdmission } from './chat-adapter'

export type PiSessionMetadata = {
  id: string
  createdAt: string
  updatedAt: string
  lineage: SessionLineage
}

type MetadataRow = { value: string }
type PhotoRow = { id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }
function photoRow(row: PhotoRow): ConversationPhoto {
  return { id: row.id, operationId: row.operation_id, name: row.name, mediaType: row.media_type, created: row.created_at, order: row.ordinal, ...(row.entry_id ? { entryId: row.entry_id } : {}) }
}
/** Domain associations, media and indexing. Native Pi owns all execution state. */
export class PiSessionStorage extends ConversationArchive {
  constructor(durable: DurableObjectStorage) {
    super(durable)
    durable.sql.exec(`
      CREATE TABLE IF NOT EXISTS inbound_receipts (identity TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound_reactions (identity TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS keet_feed (sequence INTEGER PRIMARY KEY, identity TEXT NOT NULL UNIQUE, frame TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keet_queue (
        sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, source TEXT NOT NULL,
        entry_id TEXT, state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS keet_context (destination TEXT PRIMARY KEY, messages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keet_sources (entry_id TEXT PRIMARY KEY, source TEXT NOT NULL, prompt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS external_native_inputs (operation_id TEXT PRIMARY KEY, entry_id TEXT UNIQUE, pending INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS external_native_inputs_pending ON external_native_inputs(pending,operation_id);
      CREATE TABLE IF NOT EXISTS native_history_refs (id TEXT PRIMARY KEY, native_id INTEGER NOT NULL, part INTEGER NOT NULL, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL, role TEXT, indexed INTEGER NOT NULL DEFAULT 0, memorized INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS native_history_refs_index ON native_history_refs(indexed,native_id,part);
      CREATE INDEX IF NOT EXISTS native_history_refs_memory ON native_history_refs(memorized,native_id,part);
      CREATE TABLE IF NOT EXISTS chat_inputs (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_replaced (operation_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_dropped (entry_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_submissions (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_submissions_entry ON chat_submissions(json_extract(payload,'$.entryId'));
      CREATE INDEX IF NOT EXISTS chat_submissions_withdrawn ON chat_submissions(json_extract(payload,'$.withdrawn'));
      CREATE TABLE IF NOT EXISTS timed_wake_receipts (occurrence TEXT PRIMARY KEY, entry_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_session_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_session_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pi_prompt_submissions (
        operation_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('submitting', 'accepted')),
        entry_id TEXT,
        created_at TEXT NOT NULL,
        CHECK(
          (state = 'submitting' AND entry_id IS NULL) OR
          (state = 'accepted' AND entry_id IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS pi_steer_submissions (
        submission_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, entry_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_photos (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, name TEXT NOT NULL, media_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, ordinal INTEGER NOT NULL,
        entry_id TEXT, ready INTEGER NOT NULL DEFAULT 0, original_bytes INTEGER NOT NULL, UNIQUE(operation_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS conversation_photo_groups (operation_id TEXT PRIMARY KEY, photo_ids TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_photos_album ON conversation_photos(entry_id, created_at, id);
    `)
  }

  observeEntry(entry: Entry, nativeId: number, part: number): void {
    const archived = this.archiveMetadata(entry.id)
    const indexed = archived && archived.seq <= (this.getSetting<number>('registryIndexCursor') ?? 0) ? 1 : 0
    const memorized = archived && archived.seq <= (this.getSetting<number>('memoryExtractionRevision') ?? 0) ? 1 : 0
    this.durable.sql.exec('INSERT OR IGNORE INTO native_history_refs(id,native_id,part,seq,timestamp,type,role,indexed,memorized) VALUES (?,?,?,?,?,?,?,?,?)', entry.id, nativeId, part, entry.seq, entry.timestamp, entry.type, entry.type === 'message' ? entry.message.role : null, indexed, memorized)
  }
  references(kind: 'indexed' | 'memorized', limit = 30): Array<{ id: string; native_id: number; seq: number }> {
    return this.durable.sql.exec<{ id: string; native_id: number; seq: number }>(`SELECT id,native_id,seq FROM native_history_refs WHERE ${kind} = 0 ${kind === 'memorized' ? 'AND indexed = 1' : ''} ORDER BY native_id,part LIMIT ?`, limit).toArray()
  }
  acknowledgeReferences(kind: 'indexed' | 'memorized', ids: string[]): void {
    for (const id of ids) this.durable.sql.exec(`UPDATE native_history_refs SET ${kind} = 1 WHERE id = ? AND ${kind} = 0`, id)
  }
  archiveChildren(id: string): Entry[] { return this.durable.sql.exec<{ data: string }>("SELECT data FROM conversation_archive WHERE json_extract(data,'$.parentId')=? ORDER BY seq LIMIT 2", id).toArray().map(row => JSON.parse(row.data)) }
  latestCompaction(): Entry | undefined { const row = this.durable.sql.exec<{ data: string }>("SELECT data FROM conversation_archive WHERE json_extract(data,'$.type')='compaction' ORDER BY seq DESC LIMIT 1").toArray()[0]; return row && JSON.parse(row.data) }
  archiveCompactions(after = 0): Entry[] { return this.durable.sql.exec<{ data: string }>("SELECT data FROM conversation_archive WHERE json_extract(data,'$.type')='compaction' AND seq > ? ORDER BY seq LIMIT 31", after).toArray().map(row => JSON.parse(row.data)) }
  latestReference(): { native_id: number; timestamp: number } | undefined { return this.durable.sql.exec<{ native_id: number; timestamp: number }>('SELECT native_id,timestamp FROM native_history_refs ORDER BY native_id DESC,part DESC LIMIT 1').toArray()[0] }
  historyStats(): { messageCount: number; leafId: string | null; revision: number } {
    const count = this.durable.sql.exec<{ count: number }>("SELECT (SELECT COUNT(*) FROM native_history_refs WHERE type='message') + (SELECT COUNT(*) FROM conversation_archive a WHERE json_extract(a.data,'$.type')='message' AND NOT EXISTS (SELECT 1 FROM native_history_refs n WHERE n.id=a.id) AND NOT EXISTS (SELECT 1 FROM native_entry_ids m WHERE m.source_id=a.id)) AS count").one().count
    const leaf = this.durable.sql.exec<{ id: string; seq: number }>('SELECT id,seq FROM native_history_refs ORDER BY native_id DESC,part DESC LIMIT 1').toArray()[0]
    return { messageCount: count, leafId: leaf?.id ?? this.getLeafId(), revision: leaf?.seq ?? this.archiveMaxSeq() }
  }
  chatRecord(id: string): ChatAdmission | undefined {
    const row = this.durable.sql.exec<{ payload: string }>('SELECT payload FROM chat_submissions WHERE operation_id = ?', id).toArray()[0]
    return row && JSON.parse(row.payload)
  }
  chatForEntries(ids: string[]): Map<string, ChatAdmission> {
    const result = new Map<string, ChatAdmission>()
    for (const id of ids) for (const row of this.durable.sql.exec<{ operation_id: string; payload: string }>("SELECT operation_id,payload FROM chat_submissions WHERE json_extract(payload,'$.entryId') = ?", id)) result.set(row.operation_id, JSON.parse(row.payload))
    return result
  }
  unsettledChats(mode: 'pending' | 'recovery' | 'reconcile' = 'pending'): Map<string, ChatAdmission> {
    if (mode === 'reconcile') {
      const after = this.getSetting<number>('chatReconciliationRow') ?? 0
      const query = "SELECT rowid,operation_id,payload FROM chat_submissions WHERE rowid > ? AND json_extract(payload,'$.entryId') IS NULL AND COALESCE(json_extract(payload,'$.withdrawn'),0) = 0 AND COALESCE(json_extract(payload,'$.rejected'),0) = 0 AND NOT EXISTS (SELECT 1 FROM chat_replaced r WHERE r.operation_id = chat_submissions.operation_id) ORDER BY rowid LIMIT 20"
      let rows = this.durable.sql.exec<{ rowid: number; operation_id: string; payload: string }>(query, after).toArray()
      if (!rows.length && after) rows = this.durable.sql.exec<{ rowid: number; operation_id: string; payload: string }>(query, 0).toArray()
      const next = rows.at(-1)?.rowid ?? 0
      if (next !== after) this.setSetting('chatReconciliationRow', next)
      return new Map(rows.map(row => [row.operation_id, JSON.parse(row.payload)]))
    }
    const eligibility = mode === 'recovery' ? "AND (json_extract(payload,'$.withdrawn') = 1 OR EXISTS (SELECT 1 FROM pi_session_settings s WHERE s.key = 'withdrawn:' || operation_id AND s.value = 'true') OR (json_extract(payload,'$.entryId') IS NULL AND json_extract(payload,'$.rejected') = 1))" : ''
    return new Map(this.durable.sql.exec<{ operation_id: string; payload: string }>(`SELECT operation_id,payload FROM chat_submissions WHERE (json_extract(payload,'$.entryId') IS NULL OR json_extract(payload,'$.withdrawn') = 1) AND NOT EXISTS (SELECT 1 FROM chat_replaced r WHERE r.operation_id = chat_submissions.operation_id) ${eligibility} ORDER BY rowid DESC LIMIT 20`).toArray().map(row => [row.operation_id, JSON.parse(row.payload)]))
  }
  updateChat(id: string, patch: Partial<ChatAdmission> & { fingerprint?: string; withdrawn?: boolean }): void {
    const existing = this.chatRecord(id)
    if (!existing) return
    const updated = { ...existing, ...patch }
    if (JSON.stringify(updated) !== JSON.stringify(existing)) this.durable.sql.exec('UPDATE chat_submissions SET payload = ? WHERE operation_id = ?', JSON.stringify(updated), id)
  }
  chatRecords(): Map<string, ChatAdmission> {
    return new Map(this.durable.sql.exec<{ operation_id: string; payload: string }>('SELECT * FROM chat_submissions').toArray().map(row => [row.operation_id, JSON.parse(row.payload)]))
  }
  recordChat(id: string, record: ChatAdmission): boolean {
    const existing = this.chatRecord(id)
    if (existing) {
      if (submissionIdentity(existing) !== submissionIdentity(record)) throw new Error('Submission identity conflict')
      return false
    }
    this.durable.sql.exec('INSERT INTO chat_submissions(operation_id, payload) VALUES (?, ?)', id, JSON.stringify(record))
    return true
  }
  setChatRejected(id: string, rejected: boolean): void {
    const record = this.chatRecord(id)
    if (!record) throw new Error('Submission is missing')
    this.durable.sql.exec('UPDATE chat_submissions SET payload = ? WHERE operation_id = ?', JSON.stringify({ ...record, rejected }), id)
  }
  saveInput(operationId: string, text: string, photoIds: string[], kind: 'prompt' | 'steer'): void {
    const photos = photoIds.map(id => {
      const photo = this.photo(id)
      if (!photo || photo.operationId !== operationId) throw new Error('Submitted photo is missing')
      return photo
    })
    this.durable.sql.exec('INSERT OR IGNORE INTO chat_inputs(operation_id, payload) VALUES (?, ?)', operationId, JSON.stringify({ text, photoIds, photos, kind }))
  }
  retireInput(id: string): void { this.durable.sql.exec('DELETE FROM chat_inputs WHERE operation_id = ?', id) }
  nativeInput(id: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_inputs WHERE operation_id = ?', id).toArray()[0] }
  nativeInputs(): Array<{ operationId: string; text: string; photoIds: string[]; photos: ConversationPhoto[]; kind: 'prompt' | 'steer' }> {
    return this.durable.sql.exec<{ operation_id: string; payload: string }>('SELECT * FROM chat_inputs ORDER BY rowid').toArray().map(row => ({ operationId: row.operation_id, ...JSON.parse(row.payload) }))
  }
  inputEntry(id: string): string | undefined {
    return this.getSetting<string>(`inputEntry:${id}`) ?? this.durable.sql.exec<{ entry: string }>("SELECT json_extract(value, ?) AS entry FROM pi_session_settings WHERE key = 'inputEntries'", '$.' + JSON.stringify(id)).toArray()[0]?.entry ?? undefined
  }
  correlateInput(id: string, entryId: string): void {
    const existing = this.inputEntry(id)
    if (existing && existing !== entryId) throw new Error('Input entry identity conflict')
    if (existing === entryId) return
    this.setSetting(`inputEntry:${id}`, entryId)
    this.acceptPhotos(id, entryId)
  }
  dropped(entryId: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_dropped WHERE entry_id = ?', entryId).toArray()[0] }
  replaced(id: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_replaced WHERE operation_id = ?', id).toArray()[0] }
  eligible(id: string): boolean {
    if (this.replaced(id)) return false
    const entry = this.inputEntry(id)
    return this.getSetting<boolean>(`withdrawn:${id}`) === true || (!entry && this.chatRecord(id)?.rejected === true)
  }
  markReplaced(id: string): void { this.durable.sql.exec('INSERT OR IGNORE INTO chat_replaced(operation_id) VALUES (?)', id) }
  withdrawInput(id: string): void { if (!this.getSetting(`withdrawn:${id}`)) this.setSetting(`withdrawn:${id}`, true); this.updateChat(id, { withdrawn: true }) }
  keetCheckpoint(): number {
    return Math.max(this.getSetting<number>('inboundKeetCheckpoint') ?? 0, this.durable.sql.exec<{ sequence: number }>('SELECT sequence FROM keet_feed ORDER BY sequence DESC LIMIT 1').toArray()[0]?.sequence ?? 0)
  }

  async admitKeet(frame: KeetFrame): Promise<{ sequence: number; queued: boolean }> {
    return this.admitInbound('keet', parseChannelEvent('keet', frame, { webhookToken: '', aliases: [] }), eventIdentity(frame))
  }

  admitInbound(channel: Channel, event: ChannelEvent, original: string): { sequence: number; queued: boolean } {
    return this.durable.transactionSync(() => {
      const identity = `${channel}:${event.key}`
      const existing = this.durable.sql.exec<{ payload: string }>('SELECT payload FROM inbound_receipts WHERE identity = ?', identity).toArray()[0]
      if (existing) {
        if (existing.payload !== original) throw new ChannelError(409)
        return { sequence: this.keetCheckpoint(), queued: false }
      }
      if (event.trigger && this.durable.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM keet_queue WHERE state NOT IN ('settled','withdrawn')").one().count >= 64) throw new ChannelError(503)
      const room = `${channel}:${event.room}`
      const row = this.durable.sql.exec<{ messages: string }>('SELECT messages FROM keet_context WHERE destination = ?', room).toArray()[0]
      const context: KeetSource['context'] = row ? JSON.parse(row.messages) : []
      const reactionKey = `inboundReactions:${room}`
      const snapshots = new Map<string, Reaction>()
      for (const reaction of [...(this.getSetting<Reaction[]>(reactionKey) ?? []), ...event.reactions]) snapshots.set(JSON.stringify([reaction.targetMessageId, reaction.emoji]), reaction)
      if (event.trigger) {
        const source: InboundSource = channel === 'matrix'
          ? { kind: 'matrix', destination: event.source.destination, sender: event.source.sender, text: `[Matrix: ${event.source.destination}; sender: ${event.source.sender} (${event.source.senderId})]\n${event.source.text}`, timestamp: event.source.timestamp, context, event: event.source, original }
          : { kind: event.source.destinationKind as 'dm' | 'group', destination: event.source.destination, sender: event.source.sender, text: keetDisplayText(JSON.parse(original)), timestamp: event.source.timestamp, messageId: event.source.messageId!, context, original, event: event.source }
        const header = channel === 'keet' ? `[Keet ${source.kind === 'dm' ? 'DM' : 'Group'}: ${source.destination}; sender: ${source.sender}; message: ${event.source.messageId!.deviceId}:${event.source.messageId!.seq}]` : `[Matrix: ${source.destination}; sender: ${source.sender} (${event.source.senderId}); event: ${event.source.eventId}]`
        const reactions = [...snapshots.values()].slice(-16).filter(reaction => {
          const key = JSON.stringify([room, reaction])
          if (this.durable.sql.exec('SELECT 1 FROM inbound_reactions WHERE identity = ?', key).toArray().length) return false
          this.durable.sql.exec('INSERT INTO inbound_reactions VALUES (?)', key)
          return true
        })
        const prompt = `${header}\n${channel === 'keet' ? source.text : event.source.text}${context.length ? '\nRecent room context:\n' + context.map(item => `${item.sender}: ${item.text}`).join('\n') : ''}${reactions.length ? '\nRecent reactions to your messages:\n' + reactions.map(item => `- ${item.emoji} ×${item.externalCount} on "${item.targetText}" (message: ${item.targetMessageId.deviceId}:${item.targetMessageId.seq})`).join('\n') : ''}`
        const arrival = this.durable.sql.exec<{ next: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM keet_queue').one().next
        this.durable.sql.exec('INSERT INTO keet_queue(sequence, operation_id, prompt, source) VALUES (?, ?, ?, ?)', arrival, `${channel}:${event.key}`, prompt, JSON.stringify(source))
        this.durable.sql.exec('DELETE FROM keet_context WHERE destination = ?', room)
        this.setSetting(reactionKey, [])
      } else if (event.buffer) {
        const next = [...context, { sender: event.source.sender, text: event.source.text.slice(0,500) }].slice(-8)
        this.durable.sql.exec('INSERT INTO keet_context VALUES (?,?) ON CONFLICT(destination) DO UPDATE SET messages = excluded.messages', room, JSON.stringify(next))
      }
      if (!event.trigger && snapshots.size) this.setSetting(reactionKey, [...snapshots.values()].slice(-16))
      this.durable.sql.exec('INSERT INTO inbound_receipts VALUES (?,?)', identity, original)
      if (channel === 'keet') this.setSetting('inboundKeetCheckpoint', Math.max(this.keetCheckpoint(), event.source.sequence!))
      return { sequence: event.source.sequence ?? 0, queued: event.trigger }
    })
  }

  reserveExternalInput(id: string): boolean {
    if (this.durable.sql.exec('SELECT 1 FROM external_native_inputs WHERE operation_id=?', id).toArray()[0]) return false
    this.durable.sql.exec('INSERT INTO external_native_inputs(operation_id) VALUES (?)', id)
    return true
  }
  unresolvedExternalInputs(): string[] {
    const rows = this.durable.sql.exec<{ operation_id: string }>("SELECT operation_id FROM external_native_inputs WHERE pending=1 LIMIT 65").toArray()
    if (rows.length > 64) throw new Error('External association work limit exceeded')
    return rows.map(row => row.operation_id)
  }
  bindExternalInput(id: string, entryId: string): void {
    const row = this.durable.sql.exec<{ source: string; prompt: string }>('SELECT source,prompt FROM keet_queue WHERE operation_id=?', id).toArray()[0]
    if (!row) throw new Error('External source association is unavailable')
    const source = this.durable.sql.exec<{ source: string; prompt: string }>('SELECT source,prompt FROM keet_sources WHERE entry_id=?', entryId).toArray()[0]
    if (source && (source.source !== row.source || source.prompt !== row.prompt)) throw new Error('External source identity conflict')
    const bound = this.durable.sql.exec<{ entry_id: string | null }>('SELECT entry_id FROM external_native_inputs WHERE operation_id=?', id).toArray()[0]
    if (bound?.entry_id && bound.entry_id !== entryId) throw new Error('External entry identity conflict')
    this.durable.transactionSync(() => {
      this.durable.sql.exec('INSERT INTO keet_sources(entry_id,source,prompt) VALUES (?,?,?) ON CONFLICT(entry_id) DO NOTHING', entryId, row.source, row.prompt)
      this.durable.sql.exec('UPDATE external_native_inputs SET entry_id=?,pending=0 WHERE operation_id=? AND entry_id IS NULL', entryId, id)
    })
  }
  withdrawExternalInput(id: string): void { this.durable.transactionSync(() => {
    this.durable.sql.exec("UPDATE keet_queue SET state='withdrawn' WHERE operation_id=? AND entry_id IS NULL", id)
    this.durable.sql.exec('UPDATE external_native_inputs SET pending=0 WHERE operation_id=? AND entry_id IS NULL', id)
  }) }
  externalEntry(id: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM external_native_inputs WHERE entry_id=?', id).toArray()[0] }
  nextKeet(): { sequence: number; operationId: string; prompt: string; source: InboundSource; entryId: string | null; state: string } | undefined {
    const row = this.durable.sql.exec<{ sequence: number; operation_id: string; prompt: string; source: string; entry_id: string | null; state: string }>("SELECT * FROM keet_queue WHERE state NOT IN ('settled','withdrawn') ORDER BY sequence LIMIT 1").toArray()[0]
    return row && { sequence: row.sequence, operationId: row.operation_id, prompt: row.prompt, source: JSON.parse(row.source) as InboundSource, entryId: row.entry_id, state: row.state }
  }

  acceptKeet(sequence: number, entryId: string): void {
    const row = this.nextKeet()
    if (!row || row.sequence !== sequence || (row.entryId && row.entryId !== entryId)) throw new Error('Keet entry correlation conflict.')
    this.durable.transactionSync(() => {
      this.durable.sql.exec("UPDATE keet_queue SET state = 'accepted', entry_id = ? WHERE sequence = ?", entryId, sequence)
      this.durable.sql.exec('INSERT INTO keet_sources(entry_id, source, prompt) VALUES (?, ?, ?) ON CONFLICT(entry_id) DO NOTHING', entryId, JSON.stringify(row.source), row.prompt)
    })
  }

  settleKeet(sequence: number): void {
    this.durable.sql.exec("UPDATE keet_queue SET state = 'settled' WHERE sequence = ? AND entry_id IS NOT NULL", sequence)
  }

  acceptedKeetForMigration() {
    return this.durable.sql.exec<{ sequence: number; operation_id: string; entry_id: string | null }>("SELECT sequence, operation_id, entry_id FROM keet_queue WHERE state = 'accepted' ORDER BY sequence").toArray()
  }

  keetSource(entryId: string): InboundSource | undefined {
    const row = this.durable.sql.exec<{ source: string }>('SELECT source FROM keet_sources WHERE entry_id = ?', entryId).toArray()[0]
    return row ? JSON.parse(row.source) as InboundSource : undefined
  }

  keetModelPrompt(entryId: string): string | undefined {
    return this.durable.sql.exec<{ prompt: string }>('SELECT prompt FROM keet_sources WHERE entry_id = ?', entryId).toArray()[0]?.prompt
  }

  wakeSources(): Array<{ operationId: string; source: WakeSource }> {
    return this.durable.sql.exec<{ key: string; value: string }>("SELECT key,value FROM pi_session_settings WHERE key LIKE 'wakeSource:%'").toArray().map(row => ({ operationId: row.key.slice('wakeSource:'.length), source: JSON.parse(row.value) }))
  }

  timedWakes(): TimedWake[] { return this.getSetting<TimedWake[]>('timedWakes') ?? [] }
  wakeReceipt(source: WakeSource): string | undefined {
    return this.durable.sql.exec<{ entry_id: string }>('SELECT entry_id FROM timed_wake_receipts WHERE occurrence = ?', occurrenceKey(source)).toArray()[0]?.entry_id
  }
  advanceWake(wake: TimedWake, now: number): void {
    const wakes = this.timedWakes().filter(item => item.id !== wake.id)
    if (wake.plan.type !== 'once') wakes.push({ ...wake, nextAt: nextWake(wake.plan, Math.max(now, Date.parse(wake.nextAt))) })
    this.setSetting('timedWakes', wakes)
  }
  recordWake(source: WakeSource, entryId: string): void { this.durable.sql.exec('INSERT OR IGNORE INTO timed_wake_receipts(occurrence,entry_id) VALUES (?,?)', occurrenceKey(source), entryId) }
  initialize(metadata: PiSessionMetadata): boolean {
    if (this.isInitialized()) return false
    this.writeMetadata(metadata)
    return true
  }

  isInitialized(): boolean {
    return this.durable.sql.exec<MetadataRow>("SELECT value FROM pi_session_metadata WHERE key = 'metadata'").toArray().length > 0
  }

  getMetadataSync(): PiSessionMetadata {
    const row = this.durable.sql.exec<MetadataRow>("SELECT value FROM pi_session_metadata WHERE key = 'metadata'").toArray()[0]
    if (!row) throw new Error('Session has not been initialized.')
    return JSON.parse(row.value) as PiSessionMetadata
  }

  getLeafId(): string | null { return this.durable.sql.exec<{ id: string }>('SELECT id FROM conversation_archive ORDER BY seq DESC LIMIT 1').toArray()[0]?.id ?? null }

  getEntriesWithSeq(): Array<{ seq: number; entry: Entry }> {
    return this.entriesInOrder().map((entry) => ({ seq: entry.seq, entry }))
  }

  getPathToRoot(leafId: string | null): Entry[] {
    const path: Entry[] = []
    let current = leafId ? this.getEntrySync(leafId) : undefined
    while (current) {
      path.unshift(current)
      current = current.parentId ? this.getEntrySync(current.parentId) : undefined
    }
    return path
  }

  migrationAssociations(): Array<{ id: string; entryId: string }> {
    return [
      ...this.durable.sql.exec<{ operation_id: string; entry_id: string }>('SELECT operation_id,entry_id FROM pi_prompt_submissions WHERE entry_id IS NOT NULL').toArray().map(row => ({ id: row.operation_id, entryId: row.entry_id })),
      ...this.durable.sql.exec<{ submission_id: string; entry_id: string }>('SELECT submission_id,entry_id FROM pi_steer_submissions WHERE entry_id IS NOT NULL').toArray().map(row => ({ id: row.submission_id, entryId: row.entry_id })),
    ]
  }
  reservePhoto(photo: ConversationPhoto, fingerprint: string, originalBytes: number): boolean {
    const existing = this.durable.sql.exec<{ fingerprint: string; operation_id: string; ordinal: number; ready: number }>(
      'SELECT fingerprint, operation_id, ordinal, ready FROM conversation_photos WHERE id = ?', photo.id,
    ).toArray()[0]
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.operation_id !== photo.operationId || existing.ordinal !== photo.order) throw new Error('Photo upload identity conflict.')
      return existing.ready === 1
    }
    if (this.frozenPhotoIds(photo.operationId)) throw new Error('Photo group is already admitted.')
    const total = this.durable.sql.exec<{ bytes: number }>('SELECT COALESCE(SUM(original_bytes), 0) AS bytes FROM conversation_photos WHERE operation_id = ?', photo.operationId).toArray()[0]?.bytes ?? 0
    if (total + originalBytes > 24_000_000) throw new Error('Photo group exceeds the 24 MB original limit.')
    this.durable.sql.exec(
      'INSERT INTO conversation_photos(id, operation_id, name, media_type, fingerprint, created_at, ordinal, original_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      photo.id, photo.operationId, photo.name, photo.mediaType, fingerprint, photo.created, photo.order, originalBytes,
    )
    return false
  }

  completePhoto(id: string, fingerprint: string): void {
    this.durable.sql.exec('UPDATE conversation_photos SET ready = 1 WHERE id = ? AND fingerprint = ?', id, fingerprint)
  }

  private frozenPhotoIds(operationId: string): string[] | undefined {
    const row = this.durable.sql.exec<{ photo_ids: string }>('SELECT photo_ids FROM conversation_photo_groups WHERE operation_id = ?', operationId).toArray()[0]
    return row && JSON.parse(row.photo_ids) as string[]
  }

  freezePhotos(operationId: string, ids: string[]): void {
    const frozen = this.frozenPhotoIds(operationId)
    if (frozen) {
      if (JSON.stringify(frozen) !== JSON.stringify(ids)) throw new Error('Photo group identity conflict.')
      return
    }
    const uploaded = this.durable.sql.exec<{ id: string; ready: number }>(
      'SELECT id, ready FROM conversation_photos WHERE operation_id = ? ORDER BY ordinal', operationId,
    ).toArray()
    if (uploaded.length !== ids.length || uploaded.some((photo, index) => photo.id !== ids[index] || photo.ready !== 1)) throw new Error('Photo group is incomplete.')
    this.durable.sql.exec('INSERT INTO conversation_photo_groups(operation_id, photo_ids) VALUES (?, ?)', operationId, JSON.stringify(ids))
  }

  photosForOperation(operationId: string): ConversationPhoto[] {
    return this.durable.sql.exec<{ id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }>(
      'SELECT id, operation_id, name, media_type, created_at, ordinal, entry_id FROM conversation_photos WHERE operation_id = ? AND ready = 1 ORDER BY ordinal', operationId,
    ).toArray().map(photoRow)
  }

  photosForEntry(entryId: string): ConversationPhoto[] {
    return this.durable.sql.exec<{ id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }>(
      'SELECT id, operation_id, name, media_type, created_at, ordinal, entry_id FROM conversation_photos WHERE entry_id = ? AND ready = 1 ORDER BY ordinal', entryId,
    ).toArray().map(photoRow)
  }

  photo(id: string): ConversationPhoto | undefined {
    const row = this.durable.sql.exec<{ id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }>(
      'SELECT id, operation_id, name, media_type, created_at, ordinal, entry_id FROM conversation_photos WHERE id = ? AND ready = 1', id,
    ).toArray()[0]
    return row && photoRow(row)
  }

  acceptPhotos(operationId: string, entryId: string): void {
    const ids = this.frozenPhotoIds(operationId)
    if (!ids) {
      const uploaded = this.durable.sql.exec('SELECT 1 FROM conversation_photos WHERE operation_id = ? LIMIT 1', operationId).toArray()[0]
      if (uploaded) throw new Error('Photo group was not frozen before correlation.')
      return
    }
    for (const id of ids) {
      const photo = this.photo(id)
      // Deleted media does not invalidate an already proven native admission.
      if (!photo && this.inputEntry(operationId) === entryId) continue
      if (!photo || photo.operationId !== operationId || (photo.entryId && photo.entryId !== entryId)) throw new Error('Photo entry correlation conflict.')
      this.durable.sql.exec('UPDATE conversation_photos SET entry_id = ? WHERE id = ? AND operation_id = ? AND ready = 1', entryId, id, operationId)
    }
  }

  listPhotos(cursor?: string, limit = 30): ConversationPhotoPage {
    const capped = Math.max(1, Math.min(50, Math.floor(limit)))
    const cursorPhoto = cursor ? this.photo(cursor) : undefined
    if (cursor && !cursorPhoto?.entryId) throw new Error('Invalid album cursor.')
    const rows = this.durable.sql.exec<{ id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }>(
      `SELECT id, operation_id, name, media_type, created_at, ordinal, entry_id FROM conversation_photos
       WHERE entry_id IS NOT NULL AND ready = 1 AND (created_at < ? OR (created_at = ? AND (ordinal > ? OR (ordinal = ? AND id > ?))))
       ORDER BY created_at DESC, ordinal ASC, id ASC LIMIT ?`,
      cursorPhoto?.created ?? Number.MAX_SAFE_INTEGER, cursorPhoto?.created ?? Number.MAX_SAFE_INTEGER,
      cursorPhoto?.order ?? -1, cursorPhoto?.order ?? -1, cursor ?? '', capped + 1,
    ).toArray()
    const images = rows.slice(0, capped).map(photoRow)
    return { images, ...(rows.length > capped ? { nextCursor: images.at(-1)!.id } : {}) }
  }

  listPanelPhotos(cursor: string | undefined, limit: number): ConversationPhotoPage {
    const before = cursor ? this.photo(cursor) : undefined
    if (cursor && !before?.entryId) throw new Error('Invalid album cursor.')
    const rows = this.durable.sql.exec<{ id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }>(
      `SELECT id, operation_id, name, media_type, created_at, ordinal, entry_id FROM conversation_photos
       WHERE entry_id IS NOT NULL AND ready = 1 AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      before?.created ?? Number.MAX_SAFE_INTEGER, before?.created ?? Number.MAX_SAFE_INTEGER, cursor ?? '', limit + 1,
    ).toArray()
    const images = rows.slice(0, limit).map(photoRow)
    return { images, ...(rows.length > limit ? { nextCursor: images.at(-1)!.id } : {}) }
  }

  deletePhoto(id: string): void {
    this.durable.sql.exec('DELETE FROM conversation_photos WHERE id = ?', id)
  }

  allPhotoIds(): string[] {
    return this.durable.sql.exec<{ id: string }>('SELECT id FROM conversation_photos').toArray().map((row) => row.id)
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.durable.sql.exec<MetadataRow>('SELECT value FROM pi_session_settings WHERE key = ?', key).toArray()[0]
    return row ? JSON.parse(row.value) as T : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.durable.sql.exec(
      'INSERT INTO pi_session_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value),
    )
  }

  getOutbox(): SessionIndexEvent[] {
    const cursor = this.getSetting<number>('registryIndexCursor') ?? 0
    const sessionId = this.getMetadataSync().id
    const pending = this.archiveAfter(cursor, 30)
    const events: SessionIndexEvent[] = []
    for (const entry of pending) {
      const node = nativeSearchNode(entry)
      if (node.record?.content) events.push({
        eventId: `${sessionId}:message:${entry.seq}`, type: 'message', entryId: entry.id, entrySeq: entry.seq,
        role: node.record.kind === 'compaction' ? 'compaction' : node.record.role!, timestamp: node.createdAt, text: node.record.content,
      })
    }
    if (pending.length) {
      const last = pending.at(-1)!
      events.push({
        eventId: `${sessionId}:touch:${last.seq}`, type: 'touch', updatedAt: new Date(last.timestamp).toISOString(),
        messageCount: this.historyStats().messageCount, activeLeafId: this.historyStats().leafId,
      })
    }
    return events
  }

  acknowledgeOutbox(eventIds: string[]): void {
    const seqs = eventIds.map((id) => Number(id.split(':').at(-1))).filter(Number.isSafeInteger)
    if (seqs.length) this.setSetting('registryIndexCursor', Math.max(this.getSetting<number>('registryIndexCursor') ?? 0, ...seqs))
  }

  private writeMetadata(metadata: PiSessionMetadata): void {
    this.durable.sql.exec(
      "INSERT INTO pi_session_metadata(key, value) VALUES ('metadata', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(metadata),
    )
  }
}
