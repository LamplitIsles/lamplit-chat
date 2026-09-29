import type { Usage } from '@earendil-works/pi-ai'
import {
  prepareStorageCommit,
  resolveListReadOptions,
  validateCommittedWrites,
  value,
  type CommittedWrite,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type ListElement,
  type ListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  type Write,
} from '@earendil-works/pi-agent-core/harness/session'
import type { Context } from '@earendil-works/pi-agent-core/harness/context'

type WriteRow = { seq: number; data: string }

const emptyUsage = (): Usage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined ? {} : {
      cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0),
    }),
    ...(left.reasoning === undefined && right.reasoning === undefined ? {} : {
      reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  }
}

const keyOf = (namespace: string, key: string) => `${namespace}\0${key}`

/** Pi v4 Storage persisted as one ordered write log in the session Durable Object. */
export class PiV4Storage implements Storage {
  private readonly entries = new Map<string, Entry>()
  private readonly entriesBySeq: Entry[] = []
  private readonly values = new Map<string, StoredValue<unknown>>()
  private readonly lists = new Map<string, ListElement<unknown>[]>()
  private readonly usageRows = new Map<string, UsageRow>()
  private stats: SessionStats = { messageCount: 0, usage: emptyUsage() }
  private nextSeq = 1

  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS pi_v4_writes (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)')
    for (const row of storage.sql.exec<WriteRow>('SELECT seq, data FROM pi_v4_writes ORDER BY seq').toArray()) {
      this.apply(JSON.parse(row.data) as CommittedWrite)
    }
  }

  async commit(writes: Write[], _context: Context) {
    const prepared = prepareStorageCommit(writes, this.nextSeq, Date.now())
    validateCommittedWrites(prepared.writes, this.nextSeq, {
      hasEntryOrUsageId: (id) => this.entries.has(id) || this.usageRows.has(id),
      hasEntryId: (id) => this.entries.has(id),
    })
    this.storage.transactionSync(() => {
      for (const write of prepared.writes) {
        this.storage.sql.exec('INSERT INTO pi_v4_writes(seq, data) VALUES (?, ?)', write.seq, JSON.stringify(write))
      }
    })
    for (const write of prepared.writes) this.apply(write)
    return { ...prepared.result, stats: this.getStatsSync() }
  }

  reset(): void {
    this.storage.sql.exec('DELETE FROM pi_v4_writes')
    this.entries.clear()
    this.entriesBySeq.length = 0
    this.values.clear()
    this.lists.clear()
    this.usageRows.clear()
    this.stats = { messageCount: 0, usage: emptyUsage() }
    this.nextSeq = 1
  }

  restoreEntries(entries: Entry[]): void {
    const writes: CommittedWrite[] = entries.map((entry, index) => ({ ...entry, kind: 'entry', seq: index + 1 }))
    validateCommittedWrites(writes, this.nextSeq, {
      hasEntryOrUsageId: (id) => this.entries.has(id) || this.usageRows.has(id),
      hasEntryId: (id) => this.entries.has(id),
    })
    this.storage.transactionSync(() => {
      for (const write of writes) {
        this.storage.sql.exec('INSERT INTO pi_v4_writes(seq, data) VALUES (?, ?)', write.seq, JSON.stringify(write))
      }
    })
    for (const write of writes) this.apply(write)
  }

  entriesInOrder(): Entry[] { return [...this.entriesBySeq] }
  getEntrySync(id: string): Entry | undefined { return this.entries.get(id) }
  getStatsSync(): SessionStats { return this.stats }
  getValueSync<T>(address: Value<T>): StoredValue<T> | undefined {
    return this.values.get(keyOf(address.namespace, address.key)) as StoredValue<T> | undefined
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    return new Map(ids.flatMap((id) => {
      const entry = this.entries.get(id)
      return entry ? [[id, entry] as const] : []
    }))
  }
  async getValue<T>(address: Value<T>, _context: Context) { return this.getValueSync(address) }
  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    return [...this.values.values()]
      .filter((stored) => stored.address.namespace === prefix.namespace && stored.address.key.startsWith(prefix.key))
      .sort((a, b) => a.address.key.localeCompare(b.address.key)) as StoredValue<T>[]
  }
  async readList<T>(address: ValueList<T>, options: ListReadOptions | undefined, _context: Context): Promise<ListElement<T>[]> {
    const resolved = resolveListReadOptions(options)
    const elements = this.lists.get(keyOf(address.namespace, address.key)) ?? []
    const filtered = elements.filter((item) => resolved.cursor === undefined ||
      (resolved.order === 'asc' ? item.seq > resolved.cursor.seq : item.seq < resolved.cursor.seq))
    return (resolved.order === 'asc' ? filtered : filtered.reverse()).slice(0, resolved.limit) as ListElement<T>[]
  }
  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    const start = this.entries.get(query.start)
    if (!start) throw new Error(`Unknown branch start: ${query.start}`)
    const path: Entry[] = []
    for (let current: Entry | undefined = start; current; current = current.parentId ? this.entries.get(current.parentId) : undefined) {
      path.push(current)
      if (current.parentId && !this.entries.has(current.parentId)) throw new Error(`Missing parent entry: ${current.parentId}`)
    }
    if (query.order === 'oldestFirst') path.reverse()
    const stopped: Entry[] = []
    for (const entry of path) {
      stopped.push(entry)
      if (entry.id === query.stopAtId || entry.type === query.stopAtType) break
    }
    return stopped.filter((entry) =>
      (query.type === undefined || entry.type === query.type) &&
      (query.customType === undefined || entry.customType === query.customType) &&
      (query.cursor === undefined || (query.order === 'oldestFirst' ? entry.seq > query.cursor.seq : entry.seq < query.cursor.seq)))
      .slice(0, query.limit === undefined ? undefined : Math.max(0, query.limit))
  }
  async scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]> {
    return (await this.scanBranch(query, context)).map(({ id, parentId, seq, timestamp, type, customType }) => ({
      id, parentId, seq, timestamp, type, ...(customType === undefined ? {} : { customType }),
    }))
  }
  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    return [...this.entriesBySeq].sort((a, b) => query.order === 'desc' ? b.seq - a.seq : a.seq - b.seq)
      .filter((entry) =>
        (query.type === undefined || entry.type === query.type) &&
        (query.customType === undefined || entry.customType === query.customType) &&
        (query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
        (query.toSeq === undefined || entry.seq <= query.toSeq))
      .slice(0, query.limit === undefined ? undefined : Math.max(0, query.limit))
  }
  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    return [...this.usageRows.values()].sort((a, b) => query.order === 'desc' ? b.seq - a.seq : a.seq - b.seq)
      .filter((row) => (query.fromSeq === undefined || row.seq >= query.fromSeq) && (query.toSeq === undefined || row.seq <= query.toSeq))
      .slice(0, query.limit === undefined ? undefined : Math.max(0, query.limit))
  }
  async getStats(_context: Context) { return this.getStatsSync() }
  async close(_context: Context): Promise<void> {}

  private apply(write: CommittedWrite): void {
    switch (write.kind) {
      case 'entry': {
        const { kind: _kind, ...entry } = write
        this.entries.set(entry.id, entry)
        this.entriesBySeq.push(entry)
        if (entry.type === 'message') this.stats = { ...this.stats, messageCount: this.stats.messageCount + 1 }
        break
      }
      case 'usage': {
        const { kind: _kind, ...row } = write
        this.usageRows.set(row.id, row)
        this.stats = { ...this.stats, usage: addUsage(this.stats.usage, row.usage) }
        break
      }
      case 'value': {
        const address = value(write.namespace, write.key)
        const key = keyOf(write.namespace, write.key)
        if (write.op === 'delete') this.values.delete(key)
        else this.values.set(key, { address, seq: write.seq, value: write.value })
        break
      }
      case 'list': {
        const key = keyOf(write.namespace, write.key)
        if (write.op === 'delete') this.lists.delete(key)
        else {
          const elements = this.lists.get(key) ?? []
          elements.push({ seq: write.seq, value: write.value })
          this.lists.set(key, elements)
        }
        break
      }
    }
    this.nextSeq = Math.max(this.nextSeq, write.seq + 1)
  }
}
