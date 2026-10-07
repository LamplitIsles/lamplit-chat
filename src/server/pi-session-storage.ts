import { keetIdentity, keetPrompt, keetSource, keetDisplayText, type KeetFrame, type KeetSource } from './keet-feed'
import { nativeSearchNode } from './conversation-search'
import { WAKE_CUSTOM_TYPE, occurrenceKey, type TimedWake, type WakeSource } from '../shared/timed-wake'
import { nextWake } from './timed-wake'
import { branchTip, laneState, operationMeta, setValue, pendingEntry, type CommittedWrite, type Entry, type PendingEntry, type SessionMetadata } from '@earendil-works/pi-agent-core/harness/session'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import type { ConversationPhoto, ConversationPhotoPage, SessionIndexEvent, SessionLineage } from '../shared/pi-contract'
import { submissionIdentity, type ChatAdmission } from './chat-adapter'
import { PiV4Storage } from './pi-v4-storage'

export type PiSessionMetadata = {
  id: string
  createdAt: string
  updatedAt: string
  lineage: SessionLineage
}

type MetadataRow = { value: string }
type PromptSubmissionRow = {
  operation_id: string
  fingerprint: string
  state: 'submitting' | 'accepted'
  entry_id: string | null
  created_at: string
}
type PhotoRow = { id: string; operation_id: string; name: string; media_type: string; created_at: number; ordinal: number; entry_id: string | null }
function photoRow(row: PhotoRow): ConversationPhoto {
  return { id: row.id, operationId: row.operation_id, name: row.name, mediaType: row.media_type, created: row.created_at, order: row.ordinal, ...(row.entry_id ? { entryId: row.entry_id } : {}) }
}
export type PromptSubmissionRecord = {
  operationId: string
  fingerprint: string
  state: 'submitting' | 'accepted'
  entryId?: string
  createdAt: string
}

/** Application metadata and indexing around Pi's v4 durable Storage. */
export class PiSessionStorage extends PiV4Storage {
  constructor(private readonly durable: DurableObjectStorage) {
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
  inputEntry(id: string): string | undefined { return this.getPromptSubmission(id)?.entryId ?? this.steerRecord(id)?.entryId }
  dropped(entryId: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_dropped WHERE entry_id = ?', entryId).toArray()[0] }
  replaced(id: string): boolean { return !!this.durable.sql.exec('SELECT 1 FROM chat_replaced WHERE operation_id = ?', id).toArray()[0] }
  eligible(id: string): boolean {
    if (this.replaced(id)) return false
    const entry = this.inputEntry(id)
    return entry ? this.dropped(entry) && !this.getEntrySync(entry) : this.chatRecords().get(id)?.rejected === true
  }
  private replaceForAdmission(id: string): void {
    const record = this.chatRecords().get(id)
    if (!record?.replacementSourceIds?.length) return
    // Operation reconciliation precedes obsolete-source rejection.
    const entry = this.inputEntry(id)
    if (entry) return
    for (const source of record.replacementSourceIds) {
      if (source === id || !this.eligible(source)) throw new Error('Recovery source is no longer eligible')
    }
    for (const source of record.replacementSourceIds) this.durable.sql.exec('INSERT INTO chat_replaced(operation_id) VALUES (?)', source)
  }

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

  keetSource(entryId: string): KeetSource | undefined {
    const row = this.durable.sql.exec<{ source: string }>('SELECT source FROM keet_sources WHERE entry_id = ?', entryId).toArray()[0]
    return row ? JSON.parse(row.source) as KeetSource : undefined
  }

  keetModelPrompt(entryId: string): string | undefined {
    return this.durable.sql.exec<{ prompt: string }>('SELECT prompt FROM keet_sources WHERE entry_id = ?', entryId).toArray()[0]?.prompt
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
  // The acceptance identity and next occurrence commit with Pi's durable inbox.
  protected override beforeCommit(writes: CommittedWrite[]): void {
    const address = pendingEntry('')
    const metaAddress = operationMeta('')
    const state = this.getValueSync(laneState('main'))?.value
    for (const write of writes) {
      if (write.kind !== 'value') continue
      if (write.op === 'set' && write.namespace === metaAddress.namespace && write.key.startsWith(metaAddress.key)) {
        const meta = write.value as import('@earendil-works/pi-agent-core/harness/session').OperationMeta
        if (meta.lane === 'main') this.replaceForAdmission(meta.operationId)
      }
      if (write.namespace !== address.namespace || !write.key.startsWith(address.key)) continue
      const entryId = write.key.slice(address.key.length)
      if (write.op === 'delete' && state?.inbox.some(item => item.entryId === entryId) &&
          !this.getEntrySync(entryId) && !writes.some(item => item.kind === 'entry' && item.id === entryId)) {
        const pending = this.getValueSync(pendingEntry(entryId))?.value
        if (pending?.type === 'message' && pending.payload.role === 'user') this.durable.sql.exec('INSERT OR IGNORE INTO chat_dropped(entry_id) VALUES (?)', entryId)
      }
      if (write.op === 'set') {
        const pending = write.value as PendingEntry
        if (pending.type === 'message' && pending.payload.role === 'user') {
          const row = this.durable.sql.exec<{ submission_id: string }>('SELECT submission_id FROM pi_steer_submissions WHERE created_at = ?', String(pending.payload.timestamp)).toArray()[0]
          if (row) this.replaceForAdmission(row.submission_id)
        }
      }
    }
    for (const write of writes) {
      if (write.kind !== 'value' || write.op !== 'set' || write.namespace !== address.namespace || !write.key.startsWith(address.key)) continue
      const pending = write.value as PendingEntry
      if (pending.type !== 'message' || pending.payload.role !== 'custom' || pending.payload.customType !== WAKE_CUSTOM_TYPE) continue
      const source = pending.payload.details as WakeSource
      if (this.wakeReceipt(source)) throw new Error('Wake occurrence already accepted.')
      const wake = this.timedWakes().find(item => item.id === source.wakeId && item.revision === source.revision && item.nextAt === source.scheduledAt)
      if (!wake) throw new Error('Wake occurrence is obsolete.')
      this.durable.sql.exec('INSERT INTO timed_wake_receipts(occurrence, entry_id) VALUES (?, ?)', occurrenceKey(source), write.key.slice(address.key.length))
      this.advanceWake(wake, Date.now())
    }
  }

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

  coreMetadata(): SessionMetadata {
    const metadata = this.getMetadataSync()
    return { id: metadata.id, createdAt: Date.parse(metadata.createdAt), storageVersion: 1 }
  }

  getLeafId(): string | null {
    return this.getValueSync(branchTip('main'))?.value ?? null
  }

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

  async replace(metadata: PiSessionMetadata, entries: Entry[]): Promise<void> {
    this.reset()
    for (const table of ['keet_feed', 'keet_queue', 'keet_context', 'keet_sources']) this.durable.sql.exec(`DELETE FROM ${table}`)
    this.durable.sql.exec('DELETE FROM pi_prompt_submissions')
    for (const table of ['chat_inputs', 'chat_replaced', 'chat_dropped', 'chat_submissions']) this.durable.sql.exec(`DELETE FROM ${table}`)
    this.durable.sql.exec('DELETE FROM pi_steer_submissions')
    this.durable.sql.exec('DELETE FROM conversation_photos')
    this.durable.sql.exec('DELETE FROM conversation_photo_groups')
    this.writeMetadata(metadata)
    this.restoreEntries(entries)
    await this.commit([setValue(branchTip('main'), entries.at(-1)?.id ?? null)], BACKGROUND_CONTEXT)
  }

  admitSteer(submissionId: string, fingerprint: string, photoIds: string[] = []): { created: boolean; timestamp: number; entryId?: string } {
    this.freezePhotos(submissionId, photoIds)
    const row = this.durable.sql.exec<{ fingerprint: string; entry_id: string | null; created_at: string }>('SELECT fingerprint, entry_id, created_at FROM pi_steer_submissions WHERE submission_id = ?', submissionId).toArray()[0]
    if (row) {
      if (row.fingerprint !== fingerprint) throw new Error('Steer submission identity conflict.')
      return { created: false, timestamp: Number(row.created_at), ...(row.entry_id ? { entryId: row.entry_id } : {}) }
    }
    const latest = this.durable.sql.exec<{ created_at: string }>('SELECT created_at FROM pi_steer_submissions ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 1').toArray()[0]
    const timestamp = Math.max(Date.now(), Number(latest?.created_at ?? 0) + 1)
    this.durable.sql.exec('INSERT INTO pi_steer_submissions(submission_id, fingerprint, created_at) VALUES (?, ?, ?)', submissionId, fingerprint, String(timestamp))
    return { created: true, timestamp }
  }

  steerRecord(submissionId: string): { entryId?: string; timestamp: number; fingerprint: string } | undefined {
    const row = this.durable.sql.exec<{ entry_id: string | null; created_at: string; fingerprint: string }>('SELECT entry_id, created_at, fingerprint FROM pi_steer_submissions WHERE submission_id = ?', submissionId).toArray()[0]
    return row ? { timestamp: Number(row.created_at), fingerprint: row.fingerprint, ...(row.entry_id ? { entryId: row.entry_id } : {}) } : undefined
  }

  acceptSteer(submissionId: string, entryId: string): void {
    const row = this.steerRecord(submissionId)
    if (!row || (row.entryId && row.entryId !== entryId)) throw new Error('Steer correlation conflict.')
    this.durable.sql.exec('UPDATE pi_steer_submissions SET entry_id = ? WHERE submission_id = ?', entryId, submissionId)
  }

  getPromptSubmission(operationId: string): PromptSubmissionRecord | undefined {
    const row = this.durable.sql.exec<PromptSubmissionRow>(
      'SELECT * FROM pi_prompt_submissions WHERE operation_id = ?', operationId,
    ).toArray()[0]
    return row ? {
      operationId: row.operation_id,
      fingerprint: row.fingerprint,
      state: row.state,
      ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
      createdAt: row.created_at,
    } : undefined
  }

  admitPromptSubmission(operationId: string, fingerprint: string, photoIds: string[] = []): { record: PromptSubmissionRecord; created: boolean } {
    this.freezePhotos(operationId, photoIds)
    const existing = this.getPromptSubmission(operationId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Prompt submission identity conflict.')
      return { record: existing, created: false }
    }
    this.durable.sql.exec(
      "INSERT INTO pi_prompt_submissions(operation_id, fingerprint, state, entry_id, created_at) VALUES (?, ?, 'submitting', NULL, ?)",
      operationId, fingerprint, new Date().toISOString(),
    )
    return { record: this.getPromptSubmission(operationId)!, created: true }
  }

  acceptPromptSubmission(operationId: string, entryId: string): PromptSubmissionRecord {
    const existing = this.getPromptSubmission(operationId)
    if (!existing) throw new Error('Prompt submission is missing before Pi correlation.')
    if (existing.state === 'accepted') {
      if (existing.entryId !== entryId) throw new Error('Prompt submission entry identity conflict.')
      this.acceptPhotos(operationId, entryId)
      return existing
    }
    this.durable.sql.exec(
      "UPDATE pi_prompt_submissions SET state = 'accepted', entry_id = ? WHERE operation_id = ? AND state = 'submitting'",
      entryId, operationId,
    )
    const accepted = this.getPromptSubmission(operationId)
    if (accepted?.state !== 'accepted' || accepted.entryId !== entryId) {
      throw new Error('Prompt submission correlation was not persisted.')
    }
    this.acceptPhotos(operationId, entryId)
    return accepted
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

  private freezePhotos(operationId: string, ids: string[]): void {
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
