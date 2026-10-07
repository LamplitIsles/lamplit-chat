import type { PiSessionStorage } from '../pi-session-storage'
import type { ArchiveEntry } from '../conversation-archive'
// Test-owned historical records exercise read-only search/indexing, never native acceptance.
export function archiveFixture(store: PiSessionStorage, source: { id: string; parentId: string | null; type: string; [key: string]: unknown }): ArchiveEntry {
  const seq = (store.entriesInOrder().at(-1)?.seq ?? 0) + 1
  const entry = { seq, timestamp: Date.now(), ...source } as ArchiveEntry
  store.archive(entry)
  return entry
}
