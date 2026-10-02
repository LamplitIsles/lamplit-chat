import { expect, it } from 'vitest'
import { estimateTokens, type Entry } from '@earendil-works/pi-agent-core'
import { activeContextUsage } from './context-usage'

const assistant = (tokens: number, seq = 1): Entry => ({ id: `assistant-${seq}`, parentId: null, timestamp: seq, seq, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: seq } })
const user: Entry = { id: 'user', parentId: 'assistant-1', timestamp: 2, seq: 2, type: 'message', message: { role: 'user', content: 'trailing input', timestamp: 2 } }

it('projects only active native context and estimates trailing input with the native estimator', async () => {
  expect(await activeContextUsage([assistant(100), user], 1000)).toEqual({ tokens: 100 + estimateTokens(user.message), capacity: 1000 })
  expect(await activeContextUsage([], undefined)).toEqual({ tokens: null, capacity: null })
  expect(await activeContextUsage([assistant(0)], 1000)).toEqual({ tokens: 0, capacity: 1000 })
  for (const invalid of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(await activeContextUsage([assistant(invalid)], invalid)).toEqual({ tokens: null, capacity: null })
  }
})
it('retires retained pre-compaction usage and context-edit observations, preserving fresh coalesced completion usage', async () => {
  const old = assistant(800)
  const compact: Entry = { id: 'compact', parentId: old.id, seq: 3, timestamp: 3, type: 'compaction', summary: 'native continuity', tokensBefore: 800, retainedTail: old.type === 'message' ? [old.message] : [], fromHook: true }
  expect(await activeContextUsage([old, user, compact], 1000)).toEqual({ tokens: null, capacity: 1000 })
  expect(await activeContextUsage([old, compact, assistant(120, 4)], 1000)).toEqual({ tokens: 120, capacity: 1000 })
  expect(await activeContextUsage([old, user], 1000, 2)).toEqual({ tokens: null, capacity: 1000 })
  expect(await activeContextUsage([old, user, assistant(90, 4)], 1000, 2)).toEqual({ tokens: 90, capacity: 1000 })
  const failed = assistant(900, 5)
  if (failed.type === 'message' && failed.message.role === 'assistant') failed.message.stopReason = 'error'
  expect(await activeContextUsage([old, compact, failed], 1000)).toEqual({ tokens: null, capacity: 1000 })
})
