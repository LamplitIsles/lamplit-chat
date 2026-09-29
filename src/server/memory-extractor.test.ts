import { describe, expect, it } from 'vitest'
import { parseMemoryOperations } from './memory-extractor'

describe('memory extraction', () => {
  it('accepts structured changes tied to known transcript and memory IDs', () => {
    const operations = parseMemoryOperations({
      operations: [{
        action: 'update',
        id: 'memory-1',
        expectedUpdatedAt: '2026-07-29T00:00:00.000Z',
        kind: 'preference',
        content: 'User prefers concise responses.',
        sourceEntryId: 'entry-1',
      }],
    }, new Set(['entry-1']), new Map([['memory-1', { updatedAt: '2026-07-29T00:00:00.000Z' }]]))

    expect(operations).toEqual([{
      action: 'update',
      id: 'memory-1',
      expectedUpdatedAt: '2026-07-29T00:00:00.000Z',
      kind: 'preference',
      content: 'User prefers concise responses.',
      sourceEntryId: 'entry-1',
    }])
  })

  it('rejects changes without valid provenance', () => {
    expect(() => parseMemoryOperations({
      operations: [{
        action: 'add',
        kind: 'fact',
        content: 'Unverified fact',
        sourceEntryId: 'invented-entry',
      }],
    }, new Set(['entry-1']), new Map())).toThrow('unknown source entry')
  })

  it('rejects updates based on a stale memory snapshot', () => {
    expect(() => parseMemoryOperations({
      operations: [{
        action: 'delete',
        id: 'memory-1',
        expectedUpdatedAt: '2026-07-28T00:00:00.000Z',
        sourceEntryId: 'entry-1',
      }],
    }, new Set(['entry-1']), new Map([['memory-1', { updatedAt: '2026-07-29T00:00:00.000Z' }]])))
      .toThrow('stale memory')
  })

})
