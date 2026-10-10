import type { Message } from '@earendil-works/pi-ai'

// Read-only source records retain original IDs, including unsupported historical kinds.
// This is an archive projection, never an executable Pi session/storage implementation.
export type ArchiveEntry = { id: string; parentId: string | null; seq: number; timestamp: number } & (
  | { type: 'message'; message: Message | { role: 'custom'; customType: string; content: string; details?: unknown; timestamp: number } }
  | { type: 'compaction'; summary: string; retainedTail?: readonly Message[]; firstKeptEntryId?: string; tokensBefore: number }
  | { type: 'branch_summary'; summary: string; fromId?: string | null }
  | { type: 'custom' | 'label' | 'session_info' | 'model_change' | 'thinking_level_change'; customType?: string; name?: string; label?: string; [key: string]: unknown }
)
export class ConversationArchive {
  constructor(protected readonly durable: DurableObjectStorage) {
    durable.sql.exec("CREATE TABLE IF NOT EXISTS conversation_archive (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS native_entry_ids (native_id INTEGER PRIMARY KEY, source_id TEXT UNIQUE NOT NULL); CREATE INDEX IF NOT EXISTS conversation_archive_parent ON conversation_archive(json_extract(data,'$.parentId'),seq); CREATE INDEX IF NOT EXISTS conversation_archive_type ON conversation_archive(json_extract(data,'$.type'),seq)")
  }
  archiveMetadata(id: string): { seq: number; timestamp: number; parentId: string | null } | undefined { return this.durable.sql.exec<{ seq: number; timestamp: number; parentId: string | null }>("SELECT seq,json_extract(data,'$.timestamp') AS timestamp,json_extract(data,'$.parentId') AS parentId FROM conversation_archive WHERE id=?", id).toArray()[0] }
  archiveMaxSeq(): number { return this.durable.sql.exec<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_archive').one().seq }
  archivePage(before: number, limit: number): ArchiveEntry[] { return this.durable.sql.exec<{ data: string }>('SELECT data FROM conversation_archive WHERE seq < ? ORDER BY seq DESC LIMIT ?', before, limit).toArray().map(row => JSON.parse(row.data)) }
  archiveAfter(after: number, limit: number): ArchiveEntry[] { return this.durable.sql.exec<{ data: string }>('SELECT data FROM conversation_archive WHERE seq > ? ORDER BY seq LIMIT ?', after, limit).toArray().map(row => JSON.parse(row.data)) }
  nativeId(sourceId: string): number | undefined { return this.durable.sql.exec<{ native_id: number }>('SELECT native_id FROM native_entry_ids WHERE source_id = ?', sourceId).toArray()[0]?.native_id }
  entriesInOrder(): ArchiveEntry[] { return this.durable.sql.exec<{ data: string }>('SELECT data FROM conversation_archive ORDER BY seq').toArray().map(row => JSON.parse(row.data)) }
  getEntrySync(id: string): ArchiveEntry | undefined { const row = this.durable.sql.exec<{ data: string }>('SELECT data FROM conversation_archive WHERE id = ?', id).toArray()[0]; return row ? JSON.parse(row.data) : undefined }
  getStatsSync() { return { messageCount: this.durable.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_archive WHERE json_extract(data,'$.type')='message'").one().count } }
  archive(entry: ArchiveEntry): void { this.durable.sql.exec('INSERT OR IGNORE INTO conversation_archive(id,seq,data) VALUES (?,?,?)', entry.id, entry.seq, JSON.stringify(entry)) }
  sourceId(nativeId: number): string { return this.durable.sql.exec<{ source_id: string }>('SELECT source_id FROM native_entry_ids WHERE native_id = ?', nativeId).toArray()[0]?.source_id ?? `native:${nativeId}` }
  associate(nativeId: number, sourceId: string): void { this.durable.sql.exec('INSERT INTO native_entry_ids(native_id,source_id) VALUES (?,?)', nativeId, sourceId) }
  legacyWrites(): Array<Record<string, unknown>> {
    if (!this.durable.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_v4_writes'").toArray().length) return []
    return this.durable.sql.exec<{ data: string }>('SELECT data FROM pi_v4_writes ORDER BY seq').toArray().map(row => JSON.parse(row.data))
  }
  legacyEntries(): ArchiveEntry[] { return this.legacyWrites().filter(write => write.kind === 'entry').map(({ kind: _kind, ...entry }) => entry as ArchiveEntry) }
}
