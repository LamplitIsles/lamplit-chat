import { keetIdentity, keetPrompt, keetSource, keetDisplayText, type KeetFrame, type KeetSource } from './keet-feed'
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
      CREATE TABLE IF NOT EXISTS keet_feed (sequence INTEGER PRIMARY KEY, identity TEXT NOT NULL UNIQUE, frame TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keet_queue (
        sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL, source TEXT NOT NULL,
        entry_id TEXT, state TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS keet_context (destination TEXT PRIMARY KEY, messages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keet_sources (entry_id TEXT PRIMARY KEY, source TEXT NOT NULL, prompt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_inputs (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_replaced (operation_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_dropped (entry_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_submissions (operation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
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

  chatRecords(): Map<string, ChatAdmission> {
    return new Map(this.durable.sql.exec<{ operation_id: string; payload: string }>('SELECT * FROM chat_submissions').toArray().map(row => [row.operation_id, JSON.parse(row.payload)]))
  }
  recordChat(id: string, record: ChatAdmission): boolean {
    const existing = this.chatRecords().get(id)
    if (existing) {
      if (submissionIdentity(existing) !== submissionIdentity(record)) throw new Error('Submission identity conflict')
      return false
    }
    this.durable.sql.exec('INSERT INTO chat_submissions(operation_id, payload) VALUES (?, ?)', id, JSON.stringify(record))
    return true
  }
  setChatRejected(id: string, rejected: boolean): void {
    const record = this.chatRecords().get(id)
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
  nativeInputs(): Array<{ operationId: string; text: string; photoIds: string[]; photos: ConversationPhoto[]; kind: 'prompt' | 'steer' }> {
    return this.durable.sql.exec<{ operation_id: string; payload: string }>('SELECT * FROM chat_inputs ORDER BY rowid').toArray().map(row => ({ operationId: row.operation_id, ...JSON.parse(row.payload) }))
  }
  inputEntry(id: string): string | undefined { return this.getSetting<Record<string,string>>('inputEntries')?.[id] }
  correlateInput(id: string, entryId: string): void { this.setSetting('inputEntries', { ...this.getSetting<Record<string,string>>('inputEntries'), [id]: entryId }); this.acceptPhotos(id, entryId) }
  dropped(entryId: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_dropped WHERE entry_id = ?', entryId).toArray()[0] }
  replaced(id: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_replaced WHERE operation_id = ?', id).toArray()[0] }
  eligible(id: string): boolean {
    if (this.replaced(id)) return false
    const entry = this.inputEntry(id)
    return this.getSetting<boolean>(`withdrawn:${id}`) === true || (!entry && this.chatRecords().get(id)?.rejected === true)
  }
  markReplaced(id: string): void { this.durable.sql.exec('INSERT OR IGNORE INTO chat_replaced(operation_id) VALUES (?)', id) }
  withdrawInput(id: string): void { this.setSetting(`withdrawn:${id}`, true) }
  keetCheckpoint(): number {
    return this.durable.sql.exec<{ sequence: number }>('SELECT sequence FROM keet_feed ORDER BY sequence DESC LIMIT 1').toArray()[0]?.sequence ?? 0
  }

  async admitKeet(frame: KeetFrame): Promise<{ sequence: number; queued: boolean }> {
    const result = this.durable.transactionSync((): { sequence: number; queued: boolean } | { error: string } => {
      const current = this.keetCheckpoint()
      const identity = keetIdentity(frame)
      const encoded = JSON.stringify({
        type: frame.type, eventId: frame.eventId, sequence: frame.sequence,
        messageId: { deviceId: frame.messageId.deviceId, seq: frame.messageId.seq },
        timestamp: frame.timestamp,
        destination: { groupName: frame.destination.groupName, kind: frame.destination.kind },
        senderLabel: frame.senderLabel, text: frame.text,
        trigger: frame.trigger ?? null,
        replyTo: frame.replyTo ? { deviceId: frame.replyTo.deviceId, seq: frame.replyTo.seq } : null,
        images: frame.images ?? null,
        reactionContext: frame.reactionContext ?? null,
      })
      if (frame.sequence <= current) {
        const existing = this.durable.sql.exec<{ identity: string; frame: string }>('SELECT identity, frame FROM keet_feed WHERE sequence = ?', frame.sequence).toArray()[0]
        if (!existing || existing.identity !== identity || existing.frame !== encoded) return { error: 'Keet sequence replay conflicts with stored event.' }
        return { sequence: current, queued: false }
      }
      if (frame.sequence !== current + 1) return { error: `Keet feed gap: expected ${current + 1}, received ${frame.sequence}. Reconcile before continuing.` }
      if (this.durable.sql.exec('SELECT sequence FROM keet_feed WHERE identity = ?', identity).toArray().length) return { error: 'Keet message identity was already admitted at another sequence.' }
      this.durable.sql.exec('INSERT INTO keet_feed(sequence, identity, frame) VALUES (?, ?, ?)', frame.sequence, identity, encoded)
      let queued = false
      if (frame.destination.kind === 'group' && (frame.text.trim() || frame.images?.length)) {
        const destination = frame.destination.groupName
        const row = this.durable.sql.exec<{ messages: string }>('SELECT messages FROM keet_context WHERE destination = ?', destination).toArray()[0]
        const context = row ? JSON.parse(row.messages) as KeetSource['context'] : []
        if (frame.trigger) {
          this.enqueueKeet(frame, context)
          queued = true
          this.durable.sql.exec('DELETE FROM keet_context WHERE destination = ?', destination)
        } else {
          const next = [...context, { sender: frame.senderLabel, text: frame.text.slice(0, 500) }].slice(-8)
          this.durable.sql.exec('INSERT INTO keet_context(destination, messages) VALUES (?, ?) ON CONFLICT(destination) DO UPDATE SET messages = excluded.messages', destination, JSON.stringify(next))
        }
      } else if (frame.destination.kind === 'dm' && (frame.text.trim() || frame.images?.length)) {
        this.enqueueKeet(frame, [])
        queued = true
      }
      return { sequence: frame.sequence, queued }
    })
    if ('error' in result) throw new Error(result.error)
    return result
  }

  private enqueueKeet(frame: KeetFrame, context: KeetSource['context']): void {
    this.durable.sql.exec('INSERT INTO keet_queue(sequence, operation_id, prompt, source) VALUES (?, ?, ?, ?)',
      frame.sequence, crypto.randomUUID(), keetPrompt(frame, context), JSON.stringify({ ...keetSource(frame, context), text: keetDisplayText(frame) }))
  }

  nextKeet(): { sequence: number; operationId: string; prompt: string; source: KeetSource; entryId: string | null; state: string } | undefined {
    const row = this.durable.sql.exec<{ sequence: number; operation_id: string; prompt: string; source: string; entry_id: string | null; state: string }>("SELECT * FROM keet_queue WHERE state != 'settled' ORDER BY sequence LIMIT 1").toArray()[0]
    return row && { sequence: row.sequence, operationId: row.operation_id, prompt: row.prompt, source: JSON.parse(row.source) as KeetSource, entryId: row.entry_id, state: row.state }
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

  keetSource(entryId: string): KeetSource | undefined {
    const row = this.durable.sql.exec<{ source: string }>('SELECT source FROM keet_sources WHERE entry_id = ?', entryId).toArray()[0]
    return row ? JSON.parse(row.source) as KeetSource : undefined
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

  getLeafId(): string | null { return this.entriesInOrder().at(-1)?.id ?? null }

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
    const pending = this.entriesInOrder().filter((entry) => entry.seq > cursor)
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
        messageCount: this.getStatsSync().messageCount, activeLeafId: this.getLeafId(),
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
