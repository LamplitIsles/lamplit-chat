import type { ConversationInit, EntryId, Harness } from '@earendil-works/pi-durable'
import type { Message } from '@earendil-works/pi-ai'
import type { PiSessionStorage } from './pi-session-storage'
import type { ArchiveEntry } from './conversation-archive'

function legacyValue(store: PiSessionStorage, namespace: string, key: string): unknown {
  const write = store.legacyWrites().filter(row => row.kind === 'value' && row.namespace === namespace && row.key === key).at(-1)
  return write?.op === 'set' ? write.value : undefined
}
export function migrationPreflight(store: PiSessionStorage) {
  const state = legacyValue(store, 'pi.lane.state', 'main') as { currentOperationId?: string; inbox?: unknown[] } | undefined
  if (state?.currentOperationId || state?.inbox?.length) throw new Error('Native conversion requires the old session idle with an empty inbox; finish or explicitly cancel it on the old version before conversion')
  const all = store.legacyEntries()
  const tip = legacyValue(store, 'pi.branch.tip', 'main') as string | null | undefined
  const byId = new Map(all.map(entry => [entry.id, entry]))
  const settledKeet = store.acceptedKeetForMigration().map(row => {
    const result = legacyValue(store, 'pi.result', row.operation_id) as { operationId?: string; kind?: string; status?: string } | undefined
    if (!row.entry_id || !byId.has(row.entry_id) || result?.operationId !== row.operation_id || result.kind !== 'prompt' || !['completed', 'failed', 'aborted'].includes(result.status ?? '')) {
      throw new Error(`Native conversion cannot prove accepted Keet operation ${row.operation_id} terminal; explicitly drain it on the old version before conversion`)
    }
    return row.sequence
  })
  const path: ArchiveEntry[] = [], visited = new Set<string>()
  let id = tip
  while (id) {
    if (visited.has(id)) throw new Error('Legacy main context contains a cycle')
    visited.add(id)
    const entry = byId.get(id)
    if (!entry) throw new Error(`Legacy main context record missing: ${id}`)
    path.unshift(entry); id = entry.parentId
  }
  for (const entry of path) {
    if (entry.type === 'message') legacyMessage(entry.message)
    if (entry.type === 'compaction') {
      if (!Array.isArray(entry.retainedTail)) throw new Error(`Legacy compaction retained tail missing: ${entry.id}`)
      for (const message of entry.retainedTail) legacyMessage(message)
    }
  }
  return { all, path, settledKeet, tip: tip ?? null, records: all.length, writes: store.legacyWrites().length }
}
function legacyMessage(message: Message | { role: 'custom'; content: string; timestamp: number }): Message | undefined {
  if (message.role === 'custom') return { role: 'user', content: message.content, timestamp: message.timestamp }
  if (message.role === 'assistant' && ['error', 'aborted', 'deferred'].includes(message.stopReason)) return undefined
  if (!['user', 'assistant', 'toolResult', 'system'].includes(message.role)) throw new Error(`Unsupported stored message role: ${message.role}`)
  return message
}
/** Atomic, one-time conversion; raw writes remain intact and proven terminal Keet rows settle. */
export function legacyRootInitializer(store: PiSessionStorage): ConversationInit {
  if (store.getSetting('nativeConversion')) return async () => {}
  const plan = migrationPreflight(store)
  return async (tx, conversationId) => {
    for (const source of plan.path) {
      let model: readonly Message[] | undefined
      let kind = 'lamplit.history'
      let head: EntryId | 'self' | undefined
      if (source.type === 'message') {
        const message = legacyMessage(source.message)
        model = message ? [message] : undefined
        kind = message?.role === 'user' ? 'pi.user' : message?.role === 'assistant' ? 'pi.assistant' : 'lamplit.history'
      } else if (source.type === 'compaction') {
        // Deployed 0.99 records own the retained tail. Reset native context at
        // this checkpoint; source history and original IDs remain in the archive.
        if (!Array.isArray(source.retainedTail)) throw new Error(`Legacy compaction retained tail missing: ${source.id}`)
        kind = 'lamplit.converted-context'
        model = [{ role: 'user', content: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${source.summary}\n</summary>`, timestamp: source.timestamp }, ...source.retainedTail.flatMap(message => { const converted = legacyMessage(message); return converted ? [converted] : [] })]
        head = 'self'
      } else if (source.type === 'branch_summary' && source.summary) {
        // Historical branch summaries contributed a message, never a reset.
        model = [{ role: 'user', content: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${source.summary}</summary>`, timestamp: source.timestamp }]
      }
      const entry = await tx.appendEntry(conversationId, { kind, ...(model ? { model } : {}), ...(head ? { head } : {}), data: { sourceId: source.id } })
      store.associate(entry.id, source.id)
    }
    for (const source of plan.all) store.archive(source)
    const name = legacyValue(store, 'pi.session.name', '')
    if (typeof name === 'string') store.setSetting('name', name)
    // Existing accepted operation and media identities stay domain associations; no historic model runs replay.
    const sql = store.migrationAssociations()
    for (const association of sql) {
      store.correlateInput(association.id, association.entryId)
      if (store.dropped(association.entryId) && !store.getEntrySync(association.entryId)) store.withdrawInput(association.id)
    }
    for (const sequence of plan.settledKeet) store.settleKeet(sequence)
    store.setSetting('nativeConversion', { version: 1, records: plan.records, writes: plan.writes, activeTip: plan.tip })
  }
}
export async function ensureNativeRoot(harness: Harness, store: PiSessionStorage, context: Parameters<Harness['close']>[0]) {
  return harness.root(context, { init: legacyRootInitializer(store) })
}
