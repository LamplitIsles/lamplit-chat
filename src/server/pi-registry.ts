import type { SearchBackend } from '@lamplit/contracts'
import { parseSearchId, searchId, searchSnippet } from './conversation-search'
import { MaterialFailure, materialCheck, materialReply } from './companion-materials'
import { MemoryUpdateSchema, MemoryDeleteSchema, type MaterialRequest, type MaterialReply } from '../shared/companion-materials'
import { HistoryArchives, HistoryFailure } from './history-archives'
import { safeDiagnostic, hashSourceId } from './history-import-api'
import type { HistoryReply } from '../shared/history-import'
import { hostedCallable, HostedAgent } from './hosted-agent'
import type {
  ApplyMemoryExtractionInput,
  Memory,
  MemoryKind,
  RelationshipRecord,
  RelationshipSnapshot,
  RelationshipState,
  RelationshipUpdate,
  SessionIndexEvent,
  SessionLineage,
  SessionListInput,
  SessionOverview,
  SessionSearchResult,
  SessionStatus,
  SessionSummary,
} from '../shared/pi-contract'
import { canonicalizeChangeReason, canonicalizeHistoryPageRead, canonicalizeRelationshipUpdate, canonicalizeSignature, clampAffinity } from './relationship-validation'
import { DEFAULT_USER_TIME_ZONE, validUserTimeZone } from './turn-time'

type SessionRow = {
  id: string
  name: string | null
  status: SessionStatus
  created_at: string
  updated_at: string
  message_count: number
  active_leaf_id: string | null
  lineage_type: SessionLineage['type']
  parent_session_id: string | null
  source_entry_id: string | null
}

type SearchRow = SessionRow & {
  archive_metadata: string | null
  entry_id: string
  role: string
  timestamp: string
  text: string
}

type MemoryRow = {
  id: string
  kind: MemoryKind
  content: string
  source_session_id: string | null
  source_entry_id: string | null
  created_at: string
  updated_at: string
}

type RelationshipRow = { id: number; at: string; changes: string; state: string }
const INITIAL_RELATIONSHIP: RelationshipState = { mood: 'neutral', affinity: 50, signature: '' }

type InitializeMetadata = Pick<SessionSummary, 'id' | 'createdAt' | 'updatedAt' | 'lineage'> & { name?: string }

type PiSessionInternal = {
  revokePersonalSession(tokenHash: string): Promise<void>
  initialize(metadata: InitializeMetadata): Promise<SessionOverview>
  getOverview(): Promise<SessionOverview>
  compactionSearchEntries(): Promise<SessionIndexEvent[]>
  readSearchRecord(entryId: string): ReturnType<SearchBackend['searchRead']>
  setSessionName(name: string): Promise<SessionOverview>
  deleteContents(): Promise<void>
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_FTS_ROWS = 500
const MAX_REGEX_LENGTH = 128
const MAX_REGEX_TEXT = 10_000
const MAX_MEMORIES = 64
const MAX_MEMORY_CONTENT = 500
const MAX_MEMORY_CONTEXT = 8_000

function relationshipRecord(row: RelationshipRow): RelationshipRecord {
  return { at: row.at, changes: JSON.parse(row.changes), state: JSON.parse(row.state) }
}

export class PiRegistry extends HostedAgent {
  private history: HistoryArchives
  private defaultSessionPromise?: Promise<SessionSummary>

  async revokePersonalSession(tokenHash: string): Promise<void> {
    this.closeSessionConnections(tokenHash)
    const sessions = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM pi_registry_sessions WHERE status <> 'deleting'").toArray()
    await Promise.all(sessions.map(({ id }) => this.session(id).revokePersonalSession(tokenHash)))
  }

  async ensureDefaultSession(): Promise<SessionSummary> {
    this.defaultSessionPromise ??= (async () => {
      const existing = this.ctx.storage.sql.exec<SessionRow>("SELECT * FROM pi_registry_sessions WHERE status = 'ready' AND name = 'Companion' ORDER BY created_at LIMIT 1").toArray()[0]
      return existing ? summaryFromRow(existing) : this.createSession({ name: 'Companion' })
    })()
    try { return await this.defaultSessionPromise }
    finally { this.defaultSessionPromise = undefined }
  }
  @hostedCallable()
  async reportUserTimeZone(timeZone: string): Promise<string> {
    const valid = typeof timeZone === 'string' && validUserTimeZone(timeZone)
    if (valid) await this.ctx.storage.put('userTimeZone', valid)
    return this.getUserTimeZone()
  }

  @hostedCallable()
  async getUserTimeZone(): Promise<string> {
    return (await this.ctx.storage.get<string>('userTimeZone')) ?? DEFAULT_USER_TIME_ZONE
  }

  async getReportedTimeZone(): Promise<string | undefined> {
    return this.ctx.storage.get<string>('userTimeZone')
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_registry_sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'deleting', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        active_leaf_id TEXT,
        lineage_type TEXT NOT NULL CHECK (lineage_type IN ('new', 'fork', 'clone')),
        parent_session_id TEXT,
        source_entry_id TEXT
      );
      CREATE INDEX IF NOT EXISTS pi_registry_sessions_updated
        ON pi_registry_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS pi_registry_sessions_parent
        ON pi_registry_sessions(parent_session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pi_registry_search_entries (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        entry_seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      );
      CREATE INDEX IF NOT EXISTS pi_registry_search_session_seq
        ON pi_registry_search_entries(session_id, entry_seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS pi_registry_search_fts USING fts5(
        session_id UNINDEXED,
        entry_id UNINDEXED,
        role UNINDEXED,
        timestamp UNINDEXED,
        text
      );

      CREATE TABLE IF NOT EXISTS pi_registry_applied_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_registry_tombstones (
        session_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pi_registry_memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'instruction', 'decision')),
        content TEXT NOT NULL,
        source_session_id TEXT,
        source_entry_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pi_registry_memories_updated
        ON pi_registry_memories(updated_at DESC);
      CREATE TABLE IF NOT EXISTS pi_registry_memory_extractions (
        extraction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        through_revision INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pi_registry_relationship_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        changes TEXT NOT NULL,
        state TEXT NOT NULL
      );
    `)
    this.history = new HistoryArchives(this.ctx.storage, (id, node, seq) => {
      const text = node.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      this.upsertSearchEntry(id, node.id, seq, node.role, node.time.raw, text)
    })
  }

  // Internal RPC only. HTTP authenticates and selects this registry; no browser-callable import RPC.
  async historyRequest(action: string, params: { id?: string; input?: unknown; after?: string | number; limit?: number }): Promise<HistoryReply> {
    const started = Date.now()
    try {
      const id = params.id ?? ''
      let body: unknown
      switch (action) {
        case 'settings': body = this.history.settings(); break
        case 'start': body = await this.history.start(params.input); break
        case 'append': body = await this.history.append(id, params.input); break
        case 'commit': body = this.history.commit(id, params.input); break
        case 'status': body = this.history.getStatus(id); break
        case 'cancel': this.history.cancel(id); body = { cancelled: true }; break
        case 'list': body = this.history.list(String(params.after ?? ''), params.limit ?? 20); break
        case 'read': body = this.history.read(id, Number(params.after ?? 0), params.limit ?? 20); break
        case 'diagnostics': {
          const event = await safeDiagnostic(params.input, crypto.randomUUID())
          const issueId = event.issueId
          if (!this.history.diagnosticAllowed()) throw new HistoryFailure('rate-limit', 429)
          console.info(JSON.stringify(event))
          body = { issueId }; break
        }
        default: throw new HistoryFailure('not-found', 404)
      }
      return { status: 200, body }
    } catch (error) {
      const failure = error instanceof HistoryFailure ? error : new HistoryFailure('internal-error', 500)
      const issueId = crypto.randomUUID()
      if (this.history.diagnosticAllowed()) {
        const sourceNodeIdHash = failure.sourceNodeId ? await hashSourceId(failure.sourceNodeId) : undefined
        console.info(JSON.stringify({ event: 'history-import', issueId, stage: action, code: failure.code, ...this.history.failureContext(params.id ?? ''), elapsedMs: Date.now() - started, ...(sourceNodeIdHash ? { sourceNodeIdHash } : {}) }))
      }
      return { status: failure.status, body: { error: { code: failure.code, stage: action, issueId, ...(failure.sourceNodeId ? { sourceNodeId: failure.sourceNodeId } : {}) } } }
    }
  }

  async historyFailure(event: { issueId: string; stage: string; code: string }): Promise<void> {
    if (this.history.diagnosticAllowed()) console.info(JSON.stringify({ event: 'history-import', issueId: event.issueId, stage: event.stage, code: event.code }))
  }

  @hostedCallable()
  async getRelationshipSnapshot(input: { limit?: number; before?: number } = {}): Promise<RelationshipSnapshot> {
    const { limit, before } = canonicalizeHistoryPageRead(input)
    const latest = this.ctx.storage.sql.exec<RelationshipRow>(
      'SELECT * FROM pi_registry_relationship_events ORDER BY id DESC LIMIT 1',
    ).toArray()[0]
    const rows = this.ctx.storage.sql.exec<RelationshipRow>(
      'SELECT * FROM pi_registry_relationship_events WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?',
      before ?? null, before ?? null, limit + 1,
    ).toArray()
    const visible = rows.slice(0, limit)
    const older = rows[limit]
    return {
      state: latest ? JSON.parse(latest.state) as RelationshipState : { ...INITIAL_RELATIONSHIP },
      records: visible.map(relationshipRecord),
      hasEarlier: Boolean(older),
      ...(older ? { nextBefore: visible.at(-1)!.id, predecessor: relationshipRecord(older) } : {}),
    }
  }

  async getRelationshipContext(): Promise<string> {
    const { state } = await this.getRelationshipSnapshot({ limit: 1 })
    return `Current shared relationship state (descriptive, not a goal to optimize): ${JSON.stringify(state)}`
  }

  @hostedCallable()
  async updateRelationship(input: RelationshipUpdate): Promise<RelationshipState> {
    const { signature, ...rawUpdate } = input
    const update = rawUpdate.mood !== undefined || rawUpdate.affinity !== undefined
      ? canonicalizeRelationshipUpdate(rawUpdate)
      : {}
    const validSignature = signature === undefined ? undefined : {
      value: canonicalizeSignature(signature.value),
      reason: canonicalizeChangeReason(signature.reason),
    }
    if (!update.mood && !update.affinity && !validSignature) throw new Error('At least one relationship change is required.')
    return this.ctx.storage.transactionSync(() => {
      const latest = this.ctx.storage.sql.exec<RelationshipRow>(
        'SELECT * FROM pi_registry_relationship_events ORDER BY id DESC LIMIT 1',
      ).toArray()[0]
      const previous = latest ? JSON.parse(latest.state) as RelationshipState : INITIAL_RELATIONSHIP
      const state: RelationshipState = { ...previous }
      const changes: RelationshipRecord['changes'] = {}
      if (update.mood) {
        state.mood = update.mood.value
        if (update.mood.note) state.note = update.mood.note
        else delete state.note
        changes.mood = update.mood
      }
      if (update.affinity) {
        state.affinity = clampAffinity(state.affinity + update.affinity.delta)
        changes.affinity = { ...update.affinity, value: state.affinity }
      }
      if (validSignature) {
        state.signature = validSignature.value
        changes.signature = validSignature
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO pi_registry_relationship_events (at, changes, state) VALUES (?, ?, ?)',
        new Date().toISOString(), JSON.stringify(changes), JSON.stringify(state),
      )
      return state
    })
  }

  async hasReadySession(sessionId: string): Promise<boolean> {
    return this.ctx.storage.sql.exec<SessionRow>(
      "SELECT * FROM pi_registry_sessions WHERE id = ? AND status = 'ready'",
      sessionId,
    ).toArray().length > 0 && !this.isTombstoned(sessionId)
  }

  @hostedCallable()
  async createSession(input: { name?: string } = {}): Promise<SessionSummary> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const name = cleanName(input.name)
    const lineage: SessionLineage = { type: 'new' }
    this.insertCreatingSession(id, name, now, lineage)

    try {
      const overview = await this.session(id).initialize({
        id,
        name,
        createdAt: now,
        updatedAt: now,
        lineage,
      })
      this.storeOverview(overview)
      return summaryFromOverview(overview)
    } catch (error) {
      await this.cleanupFailedSession(id)
      throw error
    }
  }

  @hostedCallable()
  async listSessions(input: SessionListInput = {}): Promise<SessionSummary[]> {
    const limit = boundedLimit(input.limit)
    const query = input.query?.trim()
    if (query) {
      const matches = this.groupedSearch({ ...input, limit }, false)
      const matchedIds = new Set(matches.map(({ session }) => session.id))
      const nameRows = this.ctx.storage.sql.exec<SessionRow>(
        `SELECT * FROM pi_registry_sessions
         WHERE status = 'ready' AND (name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC LIMIT ?`,
        `%${escapeLike(query)}%`,
        `%${escapeLike(query)}%`,
        limit,
      ).toArray()
      return [...matches.map(({ session }) => session), ...nameRows.filter((row) => !matchedIds.has(row.id)).map(summaryFromRow)]
        .slice(0, limit)
    }

    const rows = this.ctx.storage.sql.exec<SessionRow>(
      `SELECT * FROM pi_registry_sessions
       WHERE status = 'ready' AND (? = 0 OR name IS NOT NULL)
       ORDER BY updated_at DESC`,
      input.namedOnly ? 1 : 0,
    ).toArray()
    if (input.sort === 'threaded') return threaded(rows).slice(0, limit).map(summaryFromRow)
    return rows.slice(0, limit).map(summaryFromRow)
  }

  @hostedCallable()
  async searchSessions(input: SessionListInput): Promise<SessionSearchResult[]> {
    return this.groupedSearch(input, true)
  }

  private groupedSearch(input: SessionListInput, includeArchives: boolean): SessionSearchResult[] {
    const query = input.query?.trim()
    if (!query) return []
    const limit = boundedLimit(input.limit)
    const rows = query.startsWith('re:')
      ? this.regexSearch(query.slice(3).trim(), input.namedOnly === true, includeArchives)
      : this.ftsSearch(ftsQuery(query), limit, input.namedOnly === true, includeArchives)
    const grouped = groupSearchRows(rows, limit)
    if (input.sort === 'recent') grouped.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    return grouped
  }

  private summaryRefresh?: Promise<void>
  private refreshStoredSummaries(): Promise<void> {
    return this.summaryRefresh ??= (async () => {
      const sessions = this.ctx.storage.sql.exec<SessionRow>("SELECT * FROM pi_registry_sessions WHERE status = 'ready'").toArray()
      for (const row of sessions) {
        const key = `searchSummaries:${row.id}`
        if (await this.ctx.storage.get(key)) continue
        const events = await this.session(row.id).compactionSearchEntries()
        await this.applyIndexEvents(row.id, events)
        await this.ctx.storage.put(key, true)
      }
    })().finally(() => { this.summaryRefresh = undefined })
  }

  async search(input: Parameters<SearchBackend['search']>[0]): ReturnType<SearchBackend['search']> {
    await this.refreshStoredSummaries()
    const rows = this.ftsSearch(ftsQuery(input.query), 21, false, true, true)
    return { hits: rows.slice(0, 20).map(row => ({
      id: searchId(row.id, row.entry_id), sessionId: row.id, ...(row.name ? { sessionName: row.name } : {}),
      kind: row.role === 'compaction' ? 'compaction' : 'message',
      ...(row.role === 'user' || row.role === 'assistant' ? { role: row.role } : {}),
      createdAt: row.timestamp, snippet: searchSnippet(row.text, input.query),
    })), estimatedTotalHits: null, limited: rows.length > 20 }
  }

  async searchRead(input: Parameters<SearchBackend['searchRead']>[0]): ReturnType<SearchBackend['searchRead']> {
    const [sessionId, entryId] = parseSearchId(input.id)
    // Resolve imports only in this registry, and native sessions only after membership.
    if (this.history.hasArchive(sessionId)) return this.history.readSearchRecord(sessionId, entryId)
    this.requireSession(sessionId)
    return this.session(sessionId).readSearchRecord(entryId)
  }

  @hostedCallable()
  async renameSession(sessionId: string, name?: string): Promise<SessionSummary> {
    this.requireSession(sessionId)
    const overview = await this.session(sessionId).setSessionName(cleanName(name) ?? '')
    this.storeOverview(overview)
    return summaryFromOverview(overview)
  }

  @hostedCallable()
  async deleteSession(sessionId: string): Promise<void> {
    const row = this.ctx.storage.sql.exec<SessionRow>('SELECT * FROM pi_registry_sessions WHERE id = ?', sessionId).toArray()[0]
    if (!row || this.isTombstoned(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    const deletedAt = new Date().toISOString()
    this.ctx.storage.sql.exec("UPDATE pi_registry_sessions SET status = 'deleting' WHERE id = ?", sessionId)
    try {
      await this.session(sessionId).deleteContents()
      this.ctx.storage.transactionSync(() => this.removeSession(sessionId, deletedAt))
    } catch (error) {
      this.markError(sessionId)
      throw error
    }
  }

  async materialsMemoryRequest({ action, id = '', input }: MaterialRequest): Promise<MaterialReply> {
    return materialReply(async () => {
      if (action === 'memory-list') {
        const memories = (await this.listMemories()).sort((a, b) => a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        return { status: 200, body: { memories } }
      }
      const data = action === 'memory-update' ? materialCheck(MemoryUpdateSchema, input) : materialCheck(MemoryDeleteSchema, input)
      if (!id || id.length > 200) throw new MaterialFailure('invalid-data')
      return this.ctx.storage.transactionSync(() => {
        const row = this.memoryRow(id)
        if (!row) throw new MaterialFailure('not-found', 404)
        if (row.updated_at !== data.expectedUpdatedAt) throw new MaterialFailure('conflict', 409)
        if (action === 'memory-delete') {
          this.ctx.storage.sql.exec('DELETE FROM pi_registry_memories WHERE id = ?', id)
          return { status: 200, body: { deleted: true } }
        }
        let content: string
        try { content = validMemoryContent(materialCheck(MemoryUpdateSchema, input).content) } catch { throw new MaterialFailure('invalid-data') }
        // Update only content and timestamp: provenance/kind/createdAt remain on the original row.
        const now = nextMemoryTimestamp(row.updated_at)
        this.ctx.storage.sql.exec('UPDATE pi_registry_memories SET content = ?, updated_at = ? WHERE id = ?', content, now, id)
        try { this.assertMemoryBudget() } catch { throw new MaterialFailure('resource-limit', 413) }
        return { status: 200, body: { memory: memoryFromRow(this.memoryRow(id)!) } }
      })
    })
  }

  async listMemories(): Promise<Memory[]> {
    return this.memoryRows().map(memoryFromRow)
  }

  async getMemoryContext(): Promise<string> {
    return renderMemoryContext(this.memoryRows())
  }

  async setMemory(input: {
    id?: string
    kind: MemoryKind
    content: string
    sourceSessionId?: string
    sourceEntryId?: string
  }): Promise<Memory> {
    const kind = validMemoryKind(input.kind)
    const content = validMemoryContent(input.content)
    const now = new Date().toISOString()
    let id = input.id?.trim()
    this.ctx.storage.transactionSync(() => {
      if (id) {
        const existing = this.memoryRow(id)
        if (!existing) throw new Error(`Memory not found: ${id}`)
        this.ctx.storage.sql.exec(
          `UPDATE pi_registry_memories SET kind = ?, content = ?, source_session_id = ?,
           source_entry_id = ?, updated_at = ? WHERE id = ?`,
          kind,
          content,
          input.sourceSessionId ?? null,
          input.sourceEntryId ?? null,
          nextMemoryTimestamp(existing.updated_at),
          id,
        )
      } else {
        const duplicate = this.ctx.storage.sql.exec<MemoryRow>(
          'SELECT * FROM pi_registry_memories WHERE lower(content) = lower(?) LIMIT 1',
          content,
        ).toArray()[0]
        if (duplicate) {
          id = duplicate.id
        } else {
          id = crypto.randomUUID()
          this.ctx.storage.sql.exec(
            `INSERT INTO pi_registry_memories(
              id, kind, content, source_session_id, source_entry_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            kind,
            content,
            input.sourceSessionId ?? null,
            input.sourceEntryId ?? null,
            now,
            now,
          )
        }
      }
      this.assertMemoryBudget()
    })
    return memoryFromRow(this.memoryRow(id!)!)
  }

  async deleteMemory(id: string): Promise<void> {
    const value = id.trim()
    if (!value) throw new Error('Memory ID is required.')
    this.ctx.storage.sql.exec('DELETE FROM pi_registry_memories WHERE id = ?', value)
  }

  async applyMemoryExtraction(input: ApplyMemoryExtractionInput): Promise<void> {
    if (!input.extractionId.trim()) throw new Error('Extraction ID is required.')
    if (!Number.isSafeInteger(input.throughRevision) || input.throughRevision < 0) {
      throw new Error('Extraction revision must be a non-negative integer.')
    }
    this.requireSession(input.sessionId)
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO pi_registry_memory_extractions(
          extraction_id, session_id, through_revision, applied_at
        ) VALUES (?, ?, ?, ?)`,
        input.extractionId,
        input.sessionId,
        input.throughRevision,
        new Date().toISOString(),
      )
      if (this.ctx.storage.sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed === 0) return

      for (const operation of input.operations) {
        this.requireIndexedSource(input.sessionId, operation.sourceEntryId)
        if (operation.action === 'delete') {
          this.ctx.storage.sql.exec(
            'DELETE FROM pi_registry_memories WHERE id = ? AND updated_at = ?',
            operation.id,
            operation.expectedUpdatedAt,
          )
          if (this.ctx.storage.sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed === 0) {
            throw new Error(`Memory changed during extraction: ${operation.id}`)
          }
          continue
        }
        const kind = validMemoryKind(operation.kind)
        const content = validMemoryContent(operation.content)
        const now = new Date().toISOString()
        if (operation.action === 'update') {
          const existing = this.memoryRow(operation.id)
          if (!existing) throw new Error(`Memory not found: ${operation.id}`)
          this.ctx.storage.sql.exec(
            `UPDATE pi_registry_memories SET kind = ?, content = ?, source_session_id = ?,
             source_entry_id = ?, updated_at = ? WHERE id = ? AND updated_at = ?`,
            kind,
            content,
            input.sessionId,
            operation.sourceEntryId,
            nextMemoryTimestamp(existing.updated_at),
            operation.id,
            operation.expectedUpdatedAt,
          )
          if (this.ctx.storage.sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed === 0) {
            throw new Error(`Memory changed during extraction: ${operation.id}`)
          }
        } else {
          const duplicate = this.ctx.storage.sql.exec<MemoryRow>(
            'SELECT * FROM pi_registry_memories WHERE lower(content) = lower(?) LIMIT 1',
            content,
          ).toArray()[0]
          if (!duplicate) {
            this.ctx.storage.sql.exec(
              `INSERT INTO pi_registry_memories(
                id, kind, content, source_session_id, source_entry_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              crypto.randomUUID(),
              kind,
              content,
              input.sessionId,
              operation.sourceEntryId,
              now,
              now,
            )
          }
        }
      }
      this.assertMemoryBudget()
    })
  }

  async applyIndexEvents(sessionId: string, events: SessionIndexEvent[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const event of events) {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO pi_registry_applied_events(event_id, session_id, applied_at) VALUES (?, ?, ?)',
          event.eventId,
          sessionId,
          new Date().toISOString(),
        )
        if (this.ctx.storage.sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed === 0) continue
        if (this.isTombstoned(sessionId)) continue

        if (event.type === 'message') {
          this.upsertSearchEntry(sessionId, event.entryId, event.entrySeq, event.role, event.timestamp, event.text)
        } else if (event.type === 'touch') {
          this.ctx.storage.sql.exec(
            `UPDATE pi_registry_sessions SET updated_at = ?, message_count = ?, active_leaf_id = ?
             WHERE id = ?`,
            event.updatedAt,
            event.messageCount,
            event.activeLeafId,
            sessionId,
          )
        } else if (event.type === 'rename') {
          this.ctx.storage.sql.exec(
            'UPDATE pi_registry_sessions SET name = ? WHERE id = ?',
            cleanName(event.name) ?? null,
            sessionId,
          )
        } else {
          this.removeSession(sessionId, new Date().toISOString())
        }
      }
    })
  }

  private insertCreatingSession(id: string, name: string | undefined, now: string, lineage: SessionLineage): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO pi_registry_sessions(
        id, name, status, created_at, updated_at, message_count, active_leaf_id,
        lineage_type, parent_session_id, source_entry_id
      ) VALUES (?, ?, 'creating', ?, ?, 0, NULL, ?, ?, ?)`,
      id,
      name ?? null,
      now,
      now,
      lineage.type,
      lineage.parentSessionId ?? null,
      lineage.sourceEntryId ?? null,
    )
  }

  private session(sessionId: string): PiSessionInternal {
    return this.env.PiSession.getByName(this.name === 'singleton' ? sessionId : `${this.name}:${sessionId}`) as unknown as PiSessionInternal
  }

  private storeOverview(overview: SessionOverview): void {
    this.ctx.storage.sql.exec(
      `UPDATE pi_registry_sessions SET
        name = ?, status = 'ready', updated_at = ?, message_count = ?, active_leaf_id = ?
       WHERE id = ?`,
      overview.name ?? null,
      overview.updatedAt,
      overview.messageCount,
      overview.activeLeafId,
      overview.id,
    )
  }

  private markError(sessionId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE pi_registry_sessions SET status = 'error', updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      sessionId,
    )
  }

  private async cleanupFailedSession(sessionId: string): Promise<void> {
    try {
      await this.session(sessionId).deleteContents()
    } catch (error) {
      console.error('Could not clean up failed session', sessionId, error)
    }
    this.ctx.storage.sql.exec('DELETE FROM pi_registry_sessions WHERE id = ?', sessionId)
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.ctx.storage.sql.exec<SessionRow>(
      "SELECT * FROM pi_registry_sessions WHERE id = ? AND status != 'deleting'",
      sessionId,
    ).toArray()[0]
    if (!row || this.isTombstoned(sessionId)) throw new Error(`Session not found: ${sessionId}`)
    return row
  }

  private memoryRows(): MemoryRow[] {
    return this.ctx.storage.sql.exec<MemoryRow>(
      'SELECT * FROM pi_registry_memories ORDER BY kind, created_at, id',
    ).toArray()
  }

  private memoryRow(id: string): MemoryRow | undefined {
    return this.ctx.storage.sql.exec<MemoryRow>(
      'SELECT * FROM pi_registry_memories WHERE id = ?',
      id,
    ).toArray()[0]
  }

  private requireIndexedSource(sessionId: string, entryId: string): void {
    const found = this.ctx.storage.sql.exec<{ found: number }>(
      "SELECT 1 AS found FROM pi_registry_search_entries WHERE session_id = ? AND entry_id = ? AND role = 'user' LIMIT 1",
      sessionId,
      entryId,
    ).toArray().length !== 0
    if (!found) throw new Error(`Memory source entry not found: ${entryId}`)
  }

  private assertMemoryBudget(): void {
    const rows = this.memoryRows()
    if (rows.length > MAX_MEMORIES) throw new Error(`Memory is limited to ${MAX_MEMORIES} facts.`)
    if (renderMemoryContext(rows).length > MAX_MEMORY_CONTEXT) {
      throw new Error('Memory context is full. Consolidate or delete an existing memory before adding another.')
    }
  }

  private isTombstoned(sessionId: string): boolean {
    return this.ctx.storage.sql.exec<{ found: number }>(
      'SELECT 1 AS found FROM pi_registry_tombstones WHERE session_id = ? LIMIT 1',
      sessionId,
    ).toArray().length !== 0
  }

  private removeSession(sessionId: string, deletedAt: string): void {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO pi_registry_tombstones(session_id, deleted_at) VALUES (?, ?)',
      sessionId,
      deletedAt,
    )
    this.ctx.storage.sql.exec('DELETE FROM pi_registry_search_fts WHERE session_id = ?', sessionId)
    this.ctx.storage.sql.exec('DELETE FROM pi_registry_search_entries WHERE session_id = ?', sessionId)
    this.ctx.storage.sql.exec('DELETE FROM pi_registry_sessions WHERE id = ?', sessionId)
  }

  private upsertSearchEntry(
    sessionId: string,
    entryId: string,
    entrySeq: number,
    role: string,
    timestamp: string,
    text: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO pi_registry_search_entries(session_id, entry_id, entry_seq, role, timestamp, text)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, entry_id) DO UPDATE SET
         entry_seq = excluded.entry_seq, role = excluded.role,
         timestamp = excluded.timestamp, text = excluded.text`,
      sessionId,
      entryId,
      entrySeq,
      role,
      timestamp,
      text,
    )
    this.ctx.storage.sql.exec(
      'DELETE FROM pi_registry_search_fts WHERE session_id = ? AND entry_id = ?',
      sessionId,
      entryId,
    )
    this.ctx.storage.sql.exec(
      `INSERT INTO pi_registry_search_fts(session_id, entry_id, role, timestamp, text)
       VALUES (?, ?, ?, ?, ?)`,
      sessionId,
      entryId,
      role,
      timestamp,
      segmentHan(text),
    )
  }

  private ftsSearch(query: string, sessionLimit: number, namedOnly: boolean, includeArchives: boolean, records = false): SearchRow[] {
    return this.ctx.storage.sql.exec<SearchRow>(
      `SELECT s.*, f.entry_id, f.role, f.timestamp, e.text
       FROM pi_registry_search_fts AS f
       JOIN pi_registry_search_entries AS e ON e.session_id = f.session_id AND e.entry_id = f.entry_id
       JOIN (SELECT *, NULL AS archive_metadata FROM pi_registry_sessions
         UNION ALL SELECT id, json_extract(metadata,'$.title') AS name, 'ready' AS status,
         json_extract(metadata,'$.createdAt.raw') AS created_at, json_extract(metadata,'$.updatedAt.raw') AS updated_at,
         node_count AS message_count, json_extract(metadata,'$.selectedLeafId') AS active_leaf_id,
         'new' AS lineage_type, NULL AS parent_session_id, NULL AS source_entry_id, metadata AS archive_metadata FROM history_archives) AS s ON s.id = f.session_id
       WHERE pi_registry_search_fts MATCH ? AND s.status = 'ready' AND (? = 0 OR s.name IS NOT NULL) AND (? = 1 OR s.archive_metadata IS NULL)
         ${records ? "AND f.role IN ('user', 'assistant', 'compaction')" : "AND f.role <> 'compaction'"}
       ORDER BY bm25(pi_registry_search_fts), ${records ? 'f.timestamp DESC, e.entry_seq DESC, f.session_id, f.entry_id' : 's.updated_at DESC'}
       LIMIT ?`,
      query,
      namedOnly ? 1 : 0,
      includeArchives ? 1 : 0,
      records ? sessionLimit : Math.min(MAX_FTS_ROWS, sessionLimit * 20),
    ).toArray()
  }

  private regexSearch(pattern: string, namedOnly: boolean, includeArchives: boolean): SearchRow[] {
    if (!pattern || pattern.length > MAX_REGEX_LENGTH) throw new Error(`Regex must be 1-${MAX_REGEX_LENGTH} characters.`)
    if (/\\[1-9]|\([^)]*[+*{][^)]*\)[+*{]/.test(pattern)) throw new Error('Regex contains an unsafe nested quantifier or backreference.')
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'iu')
    } catch {
      throw new Error('Invalid regular expression.')
    }
    const candidates = this.ctx.storage.sql.exec<SearchRow>(
      `SELECT s.*, e.entry_id, e.role, e.timestamp, e.text
       FROM pi_registry_search_entries AS e
       JOIN (SELECT *, NULL AS archive_metadata FROM pi_registry_sessions
         UNION ALL SELECT id, json_extract(metadata,'$.title') AS name, 'ready' AS status,
         json_extract(metadata,'$.createdAt.raw') AS created_at, json_extract(metadata,'$.updatedAt.raw') AS updated_at,
         node_count AS message_count, json_extract(metadata,'$.selectedLeafId') AS active_leaf_id,
         'new' AS lineage_type, NULL AS parent_session_id, NULL AS source_entry_id, metadata AS archive_metadata FROM history_archives) AS s ON s.id = e.session_id
       WHERE e.role <> 'compaction' AND s.status = 'ready' AND (? = 0 OR s.name IS NOT NULL) AND (? = 1 OR s.archive_metadata IS NULL)
       ORDER BY e.timestamp DESC LIMIT ?`,
      namedOnly ? 1 : 0,
      includeArchives ? 1 : 0,
      MAX_FTS_ROWS,
    ).toArray()
    return candidates.filter(({ text }) => regex.test(text.slice(0, MAX_REGEX_TEXT)))
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer.')
  return Math.min(limit, MAX_LIMIT)
}

function cleanName(name: string | undefined): string | undefined {
  const value = name?.trim()
  if (!value) return undefined
  if (value.length > 200) throw new Error('Session name exceeds 200 characters.')
  return value
}

function summaryFromOverview(overview: SessionOverview): SessionSummary {
  const { revision: _revision, running: _running, compaction: _compaction, ...summary } = overview
  return summary
}

function summaryFromRow(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    name: row.name ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    activeLeafId: row.active_leaf_id,
    lineage: {
      type: row.lineage_type,
      parentSessionId: row.parent_session_id ?? undefined,
      sourceEntryId: row.source_entry_id ?? undefined,
    },
  }
}

function threaded(rows: SessionRow[]): SessionRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const children = new Map<string, SessionRow[]>()
  const roots: SessionRow[] = []
  for (const row of rows) {
    const parentId = row.parent_session_id
    if (!parentId || !byId.has(parentId) || parentId === row.id) roots.push(row)
    else children.set(parentId, [...(children.get(parentId) ?? []), row])
  }
  const recent = (a: SessionRow, b: SessionRow) => b.updated_at.localeCompare(a.updated_at)
  roots.sort(recent)
  for (const values of children.values()) values.sort(recent)
  const result: SessionRow[] = []
  const visited = new Set<string>()
  const visit = (row: SessionRow) => {
    if (visited.has(row.id)) return
    visited.add(row.id)
    result.push(row)
    for (const child of children.get(row.id) ?? []) visit(child)
  }
  roots.forEach(visit)
  rows.forEach(visit)
  return result
}

function ftsQuery(query: string): string {
  const terms: string[] = []
  const matcher = /"([^"]+)"|(\S+)/g
  for (const match of query.matchAll(matcher)) {
    const term = (match[1] ?? match[2]).trim()
    if (term) terms.push(`"${segmentHan(term).trim().replaceAll('"', '""')}"`)
  }
  if (terms.length === 0) throw new Error('A search query is required.')
  return terms.join(' AND ')
}

function segmentHan(value: string): string {
  return value.replace(/[\p{Script=Han}]+/gu, (run) => ` ${Array.from(run).join(' ')} `)
}

function groupSearchRows(rows: SearchRow[], limit: number): SessionSearchResult[] {
  const grouped = new Map<string, SessionSearchResult>()
  for (const row of rows) {
    let result = grouped.get(row.id)
    if (!result) {
      if (grouped.size >= limit) continue
      result = { session: summaryFromRow(row), matches: [], ...(row.archive_metadata ? { archive: { id: row.id, conversation: JSON.parse(row.archive_metadata) } } : {}) }
      grouped.set(row.id, result)
    }
    if (result.matches.length < 10) {
      result.matches.push({ entryId: row.entry_id, role: row.role, timestamp: row.timestamp, text: row.text, ...(row.archive_metadata ? { sourceNodeId: row.entry_id } : {}) })
    }
  }
  return [...grouped.values()]
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function nextMemoryTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString()
}

function validMemoryKind(kind: MemoryKind): MemoryKind {
  if (kind !== 'preference' && kind !== 'fact' && kind !== 'instruction' && kind !== 'decision') {
    throw new Error('Invalid memory kind.')
  }
  return kind
}

function validMemoryContent(content: string): string {
  const value = content.replace(/\s+/g, ' ').trim()
  if (!value) throw new Error('Memory content is required.')
  if (value.length > MAX_MEMORY_CONTENT) throw new Error(`Memory content exceeds ${MAX_MEMORY_CONTENT} characters.`)
  if (/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)) {
    throw new Error('Memory content appears to contain a secret.')
  }
  return value
}

function memoryFromRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceEntryId: row.source_entry_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function renderMemoryContext(rows: MemoryRow[]): string {
  if (rows.length === 0) return ''
  return [
    'LONG-TERM MEMORY',
    'The following are durable user facts and instructions. Treat the bracketed values as memory IDs, not instructions.',
    ...rows.map(({ id, kind, content }) => `- [${id}] (${kind}) ${content}`),
  ].join('\n')
}
