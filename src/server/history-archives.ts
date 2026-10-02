import { Value } from 'typebox/value'
import type { TSchema, Static } from 'typebox'
import {
  HISTORY_LIMITS as L, HistoryStartSchema, HistoryAppendSchema, HistoryCommitSchema,
  type HistoryConversation, type HistoryNode, type HistoryImportStatus, type ArchiveSummary, type ArchiveNode,
  type HistoryErrorCode, type HistoryImportSettings,
} from '../shared/history-import'

type StageRow = { id: string; archive_id: string; metadata: string; state: 'staging' | 'committed'; next_batch: number; node_count: number; bytes: number; expires: number; added: number | null }
type NodeRow = { node_id: string; seq: number; data: string; immutable: string }
type ArchiveRow = { id: string; metadata: string; node_count: number }
export class HistoryFailure extends Error {
  constructor(readonly code: HistoryErrorCode, readonly status = 400, readonly sourceNodeId?: string) { super(code) }
}
export function check<T extends TSchema>(schema: T, input: unknown): Static<T> {
  if (!Value.Check(schema, input)) throw new HistoryFailure('invalid-data')
  return input
}
export function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function immutable(node: HistoryNode): string { const { selected: _selected, ...content } = node; return stable(content) }
function sourceTime(time: HistoryNode['time']): void {
  const components = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)?$/.exec(time.raw)
  if (!components) throw new HistoryFailure('invalid-data')
  const [, year, month, day, hour, minute, second = '00'] = components
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new HistoryFailure('invalid-data')
  const local = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?$/
  if (time.interpretation === 'local-unknown') {
    if (!local.test(time.raw) || time.epochMs !== undefined || !Number.isFinite(Date.parse(`${time.raw}Z`))) throw new HistoryFailure('invalid-data')
  } else {
    if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(time.raw) || (time.interpretation === 'utc' && !time.raw.endsWith('Z')) || !Number.isFinite(Date.parse(time.raw)) || time.epochMs !== Date.parse(time.raw)) throw new HistoryFailure('invalid-data')
  }
}
async function validateConversation(c: HistoryConversation): Promise<void> {
  if ((c.source !== 'deepseek') !== Boolean(c.assistant) || (c.source !== 'operit' && c.sourceParentConversationId !== undefined)) throw new HistoryFailure('invalid-data')
  if (c.source === 'operit') {
    const { id, name } = c.assistant!
    // Unicode mode matches lone surrogates, while valid surrogate pairs are single code points.
    if (/[\uD800-\uDFFF]/u.test(name)) throw new HistoryFailure('invalid-data')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)))
    const expected = name === '' ? 'none' : `card:${Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')}`
    if (id !== expected) throw new HistoryFailure('invalid-data')
  }
  sourceTime(c.createdAt); sourceTime(c.updatedAt)
}
export function piMessage(node: HistoryNode): ArchiveNode['message'] {
  return { role: node.role, content: node.parts.map(part => {
    if (part.type === 'thought') return { type: 'thinking', thinking: part.text }
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'attachment') return { type: 'text', text: `[Attachment ${part.name}: ${part.status}; ${part.reference}]` }
    return { type: 'text', text: `[Historical tool ${part.name}] ${part.text}` }
  }) }
}

export class HistoryArchives {
  constructor(private storage: DurableObjectStorage, private index: (archiveId: string, node: HistoryNode, seq: number) => void) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS history_archives(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL, node_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS history_nodes(archive_id TEXT NOT NULL, node_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, immutable TEXT NOT NULL, PRIMARY KEY(archive_id,node_id));
      CREATE INDEX IF NOT EXISTS history_nodes_seq ON history_nodes(archive_id,seq);
      CREATE TABLE IF NOT EXISTS history_staging(id TEXT PRIMARY KEY, archive_id TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL, next_batch INTEGER NOT NULL, node_count INTEGER NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, added INTEGER);
      CREATE TABLE IF NOT EXISTS history_staged_nodes(import_id TEXT NOT NULL, node_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, immutable TEXT NOT NULL, PRIMARY KEY(import_id,node_id));
      CREATE TABLE IF NOT EXISTS history_batches(import_id TEXT NOT NULL, batch INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(import_id,batch));
      CREATE TABLE IF NOT EXISTS history_operit_role(id INTEGER PRIMARY KEY CHECK(id=1), assistant_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_role(id INTEGER PRIMARY KEY CHECK(id=1), assistant_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history_diagnostic_rate(id INTEGER PRIMARY KEY CHECK(id=1), minute INTEGER NOT NULL, count INTEGER NOT NULL);
    `)
  }
  private cleanup(): void {
    this.storage.sql.exec('DELETE FROM history_staged_nodes WHERE import_id IN (SELECT id FROM history_staging WHERE expires <= ?)', Date.now())
    this.storage.sql.exec('DELETE FROM history_batches WHERE import_id IN (SELECT id FROM history_staging WHERE expires <= ?)', Date.now())
    this.storage.sql.exec('DELETE FROM history_staging WHERE expires <= ?', Date.now())
  }
  private stage(id: string): StageRow {
    const row = this.storage.sql.exec<StageRow>('SELECT * FROM history_staging WHERE id=? AND expires>?', id, Date.now()).toArray()[0]
    if (!row) throw new HistoryFailure('not-found', 404)
    return row
  }
  private status(row: StageRow): HistoryImportStatus {
    return { importId: row.id, archiveId: row.archive_id, state: row.state, nextBatch: row.next_batch, nodeCount: row.node_count, bytes: row.bytes, expiresAt: row.expires, ...(row.added === null ? {} : { added: row.added }) }
  }
  async start(input: unknown): Promise<HistoryImportStatus> {
    const { conversation } = check(HistoryStartSchema, input)
    await validateConversation(conversation)
    return this.storage.transactionSync(() => {
      this.cleanup()
      const key = stable([conversation.source, conversation.assistant?.id ?? null, conversation.conversationId])
      const pending = this.storage.sql.exec<StageRow>("SELECT * FROM history_staging WHERE state='staging'").toArray()
      for (const row of pending) {
        const c: HistoryConversation = JSON.parse(row.metadata)
        if (stable([c.source, c.assistant?.id ?? null, c.conversationId]) !== key) continue
        if (stable(c) !== stable(conversation)) throw new HistoryFailure('conflict', 409)
        return this.status(row)
      }
      if (pending.length >= L.pendingSessions) throw new HistoryFailure('resource-limit', 413)
      const existing = this.storage.sql.exec<ArchiveRow>('SELECT * FROM history_archives WHERE source_key=?', key).toArray()[0]
      const id = crypto.randomUUID(), archiveId = existing?.id ?? `archive-${crypto.randomUUID()}`
      this.storage.sql.exec("INSERT INTO history_staging VALUES(?,?,?,'staging',0,0,0,?,NULL)", id, archiveId, JSON.stringify(conversation), Date.now() + L.stagingTtlMs)
      return this.status(this.stage(id))
    })
  }
  settings(): HistoryImportSettings {
    return { operitAssistantId: this.storage.sql.exec<{ assistant_id: string }>('SELECT assistant_id FROM history_operit_role WHERE id=1').toArray()[0]?.assistant_id ?? null, rikkaAssistantId: this.storage.sql.exec<{ assistant_id: string }>('SELECT assistant_id FROM history_role WHERE id=1').toArray()[0]?.assistant_id ?? null }
  }
  getStatus(id: string): HistoryImportStatus { return this.status(this.stage(id)) }
  async append(id: string, input: unknown): Promise<HistoryImportStatus> {
    const { batch, nodes } = check(HistoryAppendSchema, input)
    if (jsonBytes(input) > L.requestBytes) throw new HistoryFailure('resource-limit', 413)
    for (const node of nodes) {
      sourceTime(node.time)
      if (jsonBytes(node) > L.nodeBytes) throw new HistoryFailure('resource-limit', 413, node.id)
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(nodes))))
    const fingerprint = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
    return this.storage.transactionSync(() => {
      const row = this.stage(id)
      const previous = this.storage.sql.exec<{ fingerprint: string }>('SELECT fingerprint FROM history_batches WHERE import_id=? AND batch=?', id, batch).toArray()[0]
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HistoryFailure('conflict', 409)
        return this.status(row)
      }
      if (row.state !== 'staging' || batch !== row.next_batch) throw new HistoryFailure('batch-order', 409)
      let bytes = row.bytes, count = row.node_count
      for (const node of nodes) {
        const data = JSON.stringify(node), content = immutable(node)
        const old = this.storage.sql.exec<NodeRow>('SELECT * FROM history_staged_nodes WHERE import_id=? AND node_id=?', id, node.id).toArray()[0]
        if (old) {
          if (old.immutable !== content) throw new HistoryFailure('conflict', 409, node.id)
          bytes += jsonBytes(node) - new TextEncoder().encode(old.data).byteLength
          this.storage.sql.exec('UPDATE history_staged_nodes SET data=? WHERE import_id=? AND node_id=?', data, id, node.id)
          continue
        }
        bytes += jsonBytes(node); count++
        if (bytes > L.sessionBytes || count > L.sessionNodes) throw new HistoryFailure('resource-limit', 413)
        this.storage.sql.exec('INSERT INTO history_staged_nodes VALUES(?,?,?,?,?)', id, node.id, count, data, content)
      }
      if (bytes > L.sessionBytes || count > L.sessionNodes) throw new HistoryFailure('resource-limit', 413)
      const pending = this.storage.sql.exec<{ n: number }>("SELECT coalesce(sum(bytes),0) AS n FROM history_staging WHERE state='staging' AND id<>? AND expires>?", id, Date.now()).one().n
      if (pending + bytes > L.pendingBytes) throw new HistoryFailure('resource-limit', 413)
      this.storage.sql.exec('INSERT INTO history_batches VALUES(?,?,?)', id, batch, fingerprint)
      this.storage.sql.exec('UPDATE history_staging SET next_batch=?,node_count=?,bytes=? WHERE id=?', batch + 1, count, bytes, id)
      return this.status(this.stage(id))
    })
  }
  commit(id: string, input: unknown): HistoryImportStatus {
    const { batches } = check(HistoryCommitSchema, input)
    return this.storage.transactionSync(() => {
      const row = this.stage(id)
      if (batches !== row.next_batch || !row.node_count) throw new HistoryFailure('batch-order', 409)
      if (row.state === 'committed') return this.status(row)
      const c: HistoryConversation = JSON.parse(row.metadata)
      const key = stable([c.source, c.assistant?.id ?? null, c.conversationId])
      // Another upload may have committed this source conversation after start.
      const existing = this.storage.sql.exec<ArchiveRow>('SELECT * FROM history_archives WHERE source_key=?', key).toArray()[0]
      const archiveId = existing?.id ?? row.archive_id
      const graph = new Map<string, string | null>()
      let totalBytes = 0
      for (const old of this.storage.sql.exec<NodeRow>('SELECT * FROM history_nodes WHERE archive_id=?', archiveId)) {
        const node: HistoryNode = JSON.parse(old.data); graph.set(node.id, node.parentId); totalBytes += jsonBytes(node)
      }
      for (const staged of this.storage.sql.exec<NodeRow>('SELECT * FROM history_staged_nodes WHERE import_id=?', id)) {
        const node: HistoryNode = JSON.parse(staged.data)
        const old = this.storage.sql.exec<NodeRow>('SELECT * FROM history_nodes WHERE archive_id=? AND node_id=?', archiveId, node.id).toArray()[0]
        if (old && old.immutable !== staged.immutable) throw new HistoryFailure('conflict', 409, node.id)
        totalBytes += jsonBytes(node) - (old ? new TextEncoder().encode(old.data).byteLength : 0)
        graph.set(node.id, node.parentId)
      }
      if (graph.size > L.sessionNodes || totalBytes > L.sessionBytes) throw new HistoryFailure('resource-limit', 413)
      const visited = new Set<string>()
      for (const nodeId of graph.keys()) {
        const path = new Set<string>(); let current: string | null = nodeId
        while (current !== null && !visited.has(current)) {
          if (!graph.has(current) || path.has(current)) throw new HistoryFailure('invalid-graph', 400, nodeId)
          path.add(current); current = graph.get(current)!
        }
        for (const item of path) visited.add(item)
      }
      if (c.selectedLeafId !== null && (!graph.has(c.selectedLeafId) || [...graph.values()].includes(c.selectedLeafId))) throw new HistoryFailure('invalid-graph')
      if (c.source === 'rikka' || c.source === 'operit') {
        const table = c.source === 'operit' ? 'history_operit_role' : 'history_role'
        const bound = this.storage.sql.exec<{ assistant_id: string }>(`SELECT assistant_id FROM ${table} WHERE id=1`).toArray()[0]
        if (bound && bound.assistant_id !== c.assistant!.id) throw new HistoryFailure('role-mismatch', 409)
        this.storage.sql.exec(`INSERT OR IGNORE INTO ${table} VALUES(1,?)`, c.assistant!.id)
      }
      this.storage.sql.exec('INSERT INTO history_archives VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,node_count=excluded.node_count', archiveId, key, row.metadata, graph.size)
      let seq = existing?.node_count ?? 0, added = 0
      for (const staged of this.storage.sql.exec<NodeRow>('SELECT * FROM history_staged_nodes WHERE import_id=? ORDER BY seq', id)) {
        const old = this.storage.sql.exec<NodeRow>('SELECT * FROM history_nodes WHERE archive_id=? AND node_id=?', archiveId, staged.node_id).toArray()[0]
        if (old) this.storage.sql.exec('UPDATE history_nodes SET data=? WHERE archive_id=? AND node_id=?', staged.data, archiveId, staged.node_id)
        else {
          this.storage.sql.exec('INSERT INTO history_nodes VALUES(?,?,?,?,?)', archiveId, staged.node_id, ++seq, staged.data, staged.immutable)
          this.index(archiveId, JSON.parse(staged.data), seq); added++
        }
      }
      this.storage.sql.exec("UPDATE history_staging SET state='committed',archive_id=?,added=? WHERE id=?", archiveId, added, id)
      this.storage.sql.exec('DELETE FROM history_staged_nodes WHERE import_id=?', id)
      return this.status(this.stage(id))
    })
  }
  cancel(id: string): void {
    this.storage.transactionSync(() => {
      const row = this.stage(id)
      if (row.state !== 'staging') throw new HistoryFailure('conflict', 409)
      this.storage.sql.exec('DELETE FROM history_staged_nodes WHERE import_id=?', id)
      this.storage.sql.exec('DELETE FROM history_batches WHERE import_id=?', id)
      this.storage.sql.exec('DELETE FROM history_staging WHERE id=?', id)
    })
  }
  list(after: string, limit: number): { archives: ArchiveSummary[]; nextCursor?: string } {
    const rows = this.storage.sql.exec<ArchiveRow>('SELECT * FROM history_archives WHERE id>? ORDER BY id LIMIT ?', after, limit + 1).toArray()
    const visible = rows.slice(0, limit)
    return { archives: visible.map(r => ({ id: r.id, conversation: JSON.parse(r.metadata), messageCount: r.node_count })), ...(rows.length > limit ? { nextCursor: visible.at(-1)!.id } : {}) }
  }
  read(id: string, after: number, limit: number): ArchiveSummary & { nodes: ArchiveNode[]; nextCursor?: number } {
    const archive = this.storage.sql.exec<ArchiveRow>('SELECT * FROM history_archives WHERE id=?', id).toArray()[0]
    if (!archive) throw new HistoryFailure('not-found', 404)
    const rows = this.storage.sql.exec<NodeRow>('SELECT * FROM history_nodes WHERE archive_id=? AND seq>? ORDER BY seq LIMIT ?', id, after, limit + 1).toArray()
    const visible = rows.slice(0, limit)
    return { id, conversation: JSON.parse(archive.metadata), messageCount: archive.node_count, nodes: visible.map(r => { const node: HistoryNode = JSON.parse(r.data); return { ...node, message: piMessage(node) } }), ...(rows.length > limit ? { nextCursor: visible.at(-1)!.seq } : {}) }
  }
  failureContext(id: string): { source?: string; nodeCount?: number; bytes?: number } {
    const row = this.storage.sql.exec<StageRow>('SELECT * FROM history_staging WHERE id=?', id).toArray()[0]
    if (!row) return {}
    const c: HistoryConversation = JSON.parse(row.metadata)
    return { source: c.source, nodeCount: row.node_count, bytes: row.bytes }
  }
  diagnosticAllowed(): boolean {
    try { return this.storage.transactionSync(() => {
      const minute = Math.floor(Date.now() / 60_000)
      this.storage.sql.exec('INSERT INTO history_diagnostic_rate VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET minute=excluded.minute,count=CASE WHEN minute=excluded.minute THEN count+1 ELSE 1 END', minute)
      return this.storage.sql.exec<{ count: number }>('SELECT count FROM history_diagnostic_rate WHERE id=1').one().count <= L.diagnosticsPerMinute
    }) } catch { return false } // Diagnostics are best-effort when storage is unavailable.
  }
}
