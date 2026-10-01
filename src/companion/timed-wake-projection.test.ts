import { expect, it } from 'vitest'
import { branchItems, visibleBranchEntries } from '../../frontend/src/lib/companion/pi-projection'
import type { StoredSessionEntry } from '../shared/pi-contract'
it('projects durable wake snapshots as companion sources and keeps the input visible while running', () => {
  const source = { wakeId: 'wake', revision: 'revision', scheduledAt: '2026-10-02T01:00:00Z', title: 'Tea', reminder: 'Synthetic reminder' }
  const entries: StoredSessionEntry[] = [
    { id: 'human', parentId: null, seq: 1, type: 'message', timestamp: source.scheduledAt, message: { role: 'user', content: 'Earlier human input' } },
    { id: 'source', parentId: 'human', seq: 2, type: 'message', timestamp: source.scheduledAt, wakeSource: source, message: { role: 'custom', content: 'Internal source input' } },
    { id: 'answer', parentId: 'source', seq: 3, type: 'message', timestamp: source.scheduledAt, message: { role: 'assistant', content: 'Synthetic answer' } },
  ]
  const items = branchItems(entries)
  expect(items[1]).toMatchObject({ id: 'source', kind: 'wake', side: 'incoming', source })
  expect(items.filter(item => item.kind === 'text').map(item => item.text)).toEqual(['Earlier human input', 'Synthetic answer'])
  expect(visibleBranchEntries(entries, true).map(entry => entry.id)).toEqual(['human', 'source'])
})
