import { expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { ContextView, EntryRecord } from '@earendil-works/pi-durable'
import { activeContextUsage } from './context-usage'
const entry = (id: number, tokens: number): EntryRecord => ({ id: id as never, conversationId: 1 as never, kind:'pi.assistant', model:[{ ...fauxAssistantMessage('reply'), usage: { input: tokens,output:0,cacheRead:0,cacheWrite:0,totalTokens:tokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} } }] })
const view = (entries: EntryRecord[], head?: EntryRecord): ContextView => ({ head,entries,contributions:entries.map(entry=>entry.model??[]),messages:entries.flatMap(entry=>entry.model??[]) })
it('counts a fresh observation in native active context and weakens unknown/post-compaction/failed usage to zero', () => {
  expect(activeContextUsage(view([entry(1,100)]),1000)).toEqual({ tokens:100,capacity:1000 })
  expect(activeContextUsage(view([]))).toEqual({ tokens:0,capacity:null })
  const head = { id:3 as never,conversationId:1 as never,kind:'pi.compaction' }
  expect(activeContextUsage(view([head,entry(1,800)],head),1000)).toEqual({ tokens:0,capacity:1000 })
  expect(activeContextUsage(view([head,entry(4,120)],head),1000)).toEqual({ tokens:120,capacity:1000 })
  for (const invalid of [NaN,Infinity,-1,Number.MAX_SAFE_INTEGER+1]) expect(activeContextUsage(view([entry(1,invalid)]),invalid)).toEqual({ tokens:0,capacity:null })
})
