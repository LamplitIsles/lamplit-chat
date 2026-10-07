import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { archiveFixture } from './fixtures/archive-entry'
import type { HistoryConversation, HistoryNode } from '../shared/history-import'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import type { PiSessionStorage } from './pi-session-storage'
import type { SearchBackend } from '@lamplit/contracts'

type Native = { sessionStorage: PiSessionStorage }
const history = (action: string, params: Parameters<PiRegistry['historyRequest']>[1]) => runInDurableObject(registry(), instance => (instance as unknown as PiRegistry).historyRequest(action, params))
const registry = () => env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry> & SearchBackend
async function append(stub: DurableObjectStub<PiSession>, text: string, summary = false) {
  return runInDurableObject(stub, async instance => {
    const n = instance as unknown as Native
    const id = crypto.randomUUID()
    archiveFixture(n.sessionStorage, summary
      ? { id, parentId: n.sessionStorage.getLeafId(), type: 'compaction', summary: text, firstKeptEntryId:id, tokensBefore:100 }
      : { id, parentId: n.sessionStorage.getLeafId(), type:'message', message:{role:'user',content:text,timestamp:Date.now()} })
    return n.sessionStorage.getEntrySync(id)!
  })
}
async function flush(stub: DurableObjectStub<PiSession>, id: string) {
  const events = await stub.flushOutbox()
  await registry().applyIndexEvents(id, events)
  await stub.acknowledgeOutbox(events.map(e => e.eventId))
}

it('returns native record rank without session quotas and includes stored and new summaries', async () => {
  const first = await registry().createSession({ name: 'first' })
  const second = await registry().createSession({ name: 'second' })
  const a = env.PiSession.getByName(first.id) as DurableObjectStub<PiSession>
  const b = env.PiSession.getByName(second.id) as DurableObjectStub<PiSession>
  const old = await append(a, '灯塔 lighthouse oldSummary', true)
  // Simulate the pre-feature outbox cursor: this summary was stored but omitted.
  await runInDurableObject(a, instance => (instance as unknown as Native).sessionStorage.acknowledgeOutbox([`old:${old.seq}`]))
  for (let i = 0; i < 22; i++) await append(a, '灯塔 lighthouse native message')
  await append(b, '灯塔 lighthouse native message')
  await flush(a, first.id); await flush(b, second.id)
  expect((await registry().search({ query: 'oldSummary' })).hits).toMatchObject([{ kind: 'compaction', sessionId: first.id }])
  await append(a, '灯塔 lighthouse newSummary', true); await flush(a, first.id)
  expect((await registry().search({ query: 'newSummary' })).hits).toMatchObject([{ kind: 'compaction' }])
  const results = await registry().search({ query: '灯塔 lighthouse' })
  expect(results.hits).toHaveLength(20)
  expect(results.limited).toBe(true)
  expect(results.hits.filter(h => h.sessionId === first.id).length).toBeGreaterThan(10)
  expect(new Set(results.hits.map(h => h.id)).size).toBe(20)
  expect((await registry().search({ query: 're:lighthouse' })).hits).toEqual([])
})

it('reads original native identities along parents, excludes thoughts/tools and stops at forks', async () => {
  const created = await registry().createSession({ name: 'branch reader' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  const root = await append(stub, 'before original branch')
  const target = await append(stub, 'repeated native text')
  await runInDurableObject(stub, async instance => {
    const n = instance as unknown as Native
    for (const source of [
      ({ id: 'thought', parentId: target.id, type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } }),
      ({ id: 'summary', parentId: 'thought', type: 'compaction', summary: 'nearby summary ' + '🕯'.repeat(13000), retainedTail: [], tokensBefore: 100, fromHook: false }),
      ({ id: 'fork-a', parentId: 'summary', type: 'message', message: { role: 'user', content: 'fork a hidden', timestamp: Date.now() } }),
      ({ id: 'fork-b', parentId: 'summary', type: 'message', message: { role: 'user', content: 'fork b hidden', timestamp: Date.now() } }),
      ({ id: 'other', parentId: null, type: 'message', message: { role: 'user', content: 'unrelated insertion', timestamp: Date.now() } }),
    ]) archiveFixture(n.sessionStorage, source)
  })
  await flush(stub, created.id)
  const hit = (await registry().search({ query: 'repeated native text' })).hits[0]
  const result = await registry().searchRead({ id: hit.id })
  expect(result.record.content).toBe('repeated native text')
  expect(result.context.items.map(i => i.sourceRecordIndex)).toEqual([root.seq, target.seq, target.seq + 2])
  expect(result.context.items.map(i => i.kind)).toEqual(['message', 'message', 'compaction'])
  expect(result.context.items[2].content).toContain('nearby summary')
  expect(result.context.items.reduce((count, i) => count + Array.from(i.content).length, 0)).toBe(12000)
  expect(result.context.truncated).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/secret reasoning|fork a hidden|unrelated insertion/)
  const fullSummary = (await registry().search({ query: 'nearby summary' })).hits[0]
  expect((await registry().searchRead({ id: fullSummary.id })).record.content).toHaveLength('nearby summary '.length + 26000)
})

it('reads imported parent paths and native unknown-zone time facts within the registry only', async () => {
  const { default: fixture } = await import('./fixtures/history-deepseek.json')
  const data = structuredClone(fixture) as { conversation: HistoryConversation; nodes: HistoryNode[] }
  const excluded = Array.from({ length: 25 }, (_, i): HistoryNode => ({ ...data.nodes[0], id: `excluded-${i}`, messageId: `excluded-message-${i}`, parentId: null, sourceOrder: 3 + i, selected: false, role: i % 2 ? 'tool' : 'system', parts: [{ type: 'text', text: 'excludedBeforeLimit' }] }))
  data.nodes.push(...excluded)
  data.nodes[0].parts.push({ type: 'text', text: 'excludedBeforeLimit' })
  data.nodes[0].time = { raw: '2026-10-02T12:00:00', interpretation: 'local-unknown' }
  const started = await history('start', { input: { conversation: data.conversation } })
  const status = started.body as { importId: string; archiveId: string }
  expect(started.status).toBe(200)
  expect((await history('append', { id: status.importId, input: { batch: 0, nodes: data.nodes } })).status).toBe(200)
  expect((await history('commit', { id: status.importId, input: { batches: 1 } })).status).toBe(200)
  const parent = (await registry().search({ query: 'moonflower' })).hits[0]
  expect((await registry().search({ query: 'excludedBeforeLimit' })).hits.map(h => h.id)).toEqual([parent.id])
  expect(parent.createdAt).toBe('2026-10-02T12:00:00')
  expect((await registry().searchRead({ id: parent.id })).context.items).toHaveLength(1) // fork stops at source parent
  const alternative = (await registry().search({ query: 'heliotropebranch' })).hits[0]
  const read = await registry().searchRead({ id: alternative.id })
  expect(read.record.content).toBe('Alternative heliotropebranch beside the pond.')
  expect(read.context.items.map(i => i.content)).toEqual(['Where does the moonflower grow?\nexcludedBeforeLimit', 'Alternative heliotropebranch beside the pond.'])
  expect((await registry().search({ query: 'privatethoughtquartz' })).hits).toEqual([])
  const stranger = env.PiRegistry.getByName(crypto.randomUUID()) as DurableObjectStub<PiRegistry> & SearchBackend
  await runInDurableObject(stranger, async instance => { await expect((instance as unknown as PiRegistry).searchRead({ id: alternative.id })).rejects.toThrow('Session not found') })
  const native = await registry().createSession({ name: 'private native' })
  const stub = env.PiSession.getByName(native.id) as DurableObjectStub<PiSession>
  await append(stub, 'privateOwnScopeToken'); await flush(stub, native.id)
  const ownHit = (await registry().search({ query: 'privateOwnScopeToken' })).hits[0]
  await runInDurableObject(stranger, async instance => { await expect((instance as unknown as PiRegistry).searchRead({ id: ownHit.id })).rejects.toThrow('Session not found') })
  expect((await stranger.search({ query: 'privateOwnScopeToken' })).hits).toEqual([])
})

it('ties native BM25 by record recency across sessions rather than regrouping by session updates', async () => {
  const a = await registry().createSession({ name: 'recent session' })
  const b = await registry().createSession({ name: 'old session' })
  for (const [session, times] of [[a, ['2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z']], [b, ['2026-02-01T00:00:00Z']]] as const) {
    const stub = env.PiSession.getByName(session.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async instance => {
      const n = instance as unknown as Native
      times.map((time, i) => ({ id: `dated-${i}`, parentId: i ? `dated-${i - 1}` : null, seq: i + 1, timestamp: Date.parse(time), type: 'message' as const, message: { role: 'user' as const, content: 'rankneedle same length', timestamp: Date.parse(time) } })).forEach(entry => n.sessionStorage.archive(entry))
    })
    await flush(stub, session.id)
  }
  await registry().applyIndexEvents(a.id, [{ eventId: 'ranking-touch', type: 'touch', updatedAt: '2026-10-03T00:00:00Z', messageCount: 2, activeLeafId: 'dated-1' }])
  const hits = (await registry().search({ query: 'rankneedle' })).hits
  expect(hits.map(h => h.sessionId)).toEqual([a.id, b.id, a.id])
  expect(hits.map(h => h.createdAt)).toEqual(['2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  const stub = env.PiSession.getByName(b.id) as DurableObjectStub<PiSession>
  await append(stub, 'rankneedle rankneedle'); await flush(stub, b.id)
  expect((await registry().search({ query: 'rankneedle' })).hits[0].sessionId).toBe(b.id)
})

it('bounds eight eligible records on each side and returns full selected text beyond 128 KiB on the shared socket', async () => {
  const { openChat } = await import('@lamplit/contracts/client')
  const { default: worker } = await import('../server')
  await registry().ensureDefaultSession()
  const created = await registry().createSession({ name: 'long source' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  for (let i = 0; i < 10; i++) await append(stub, `before ${i}`)
  const text = 'fullSelectedToken ' + 'x'.repeat(140000)
  const target = await append(stub, text)
  for (let i = 0; i < 10; i++) await append(stub, `after ${i}`)
  await flush(stub, created.id)
  const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), env)
  const ws = response.webSocket!; ws.accept()
  const client = await openChat(ws, () => {}, () => {})
  try {
    const hit = (await client.search({ query: 'fullSelectedToken' })).hits[0]
    const read = await client.searchRead({ id: hit.id })
    expect(read.record.content).toBe(text)
    expect(read.context.items).toHaveLength(17)
    expect(read.context.items[0].content).toBe('before 2')
    expect(read.context.items[16].content).toBe('after 7')
    expect(read.context.items[8].sourceRecordIndex).toBe(target.seq)
    expect(read.context.truncated).toBe(true)
    await expect(client.searchRead({ id: JSON.stringify([created.id, 'missing-record']) })).rejects.toThrow()
    expect((await client.search({ query: 'fullSelectedToken' })).hits[0].id).toBe(hit.id)
  } finally { client.close(); ws.close() }
})
