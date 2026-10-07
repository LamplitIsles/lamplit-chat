import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { env } from 'cloudflare:workers'
import { SELF, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { PiRegistry } from './pi-registry'
import { createSessionSearchTool } from './workspace-tools'
import type { HistoryConversation, HistoryNode, HistoryImportStatus } from '../shared/history-import'
import deepseek from './fixtures/history-deepseek.json'
import operitFixture from './fixtures/history-operit.json'
import diagnosticFixtures from './fixtures/history-diagnostics.json'
import server from '../server'

const password = 'fixture-password-long-enough'
let owner: string
beforeEach(() => { owner = crypto.randomUUID() })
function fixture(): { conversation: HistoryConversation; nodes: HistoryNode[] } {
  return structuredClone(deepseek) as { conversation: HistoryConversation; nodes: HistoryNode[] }
}
async function request(path: string, method = 'GET', data?: unknown): Promise<Response> {
  return server.fetch(new Request(`http://example.test/api/${path}`, { method, headers: { 'x-lamplit-instance': owner, 'x-lamplit-internal-secret': 'fictional-internal-secret', ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fictional-internal-secret' })
}
async function start(c = fixture().conversation): Promise<HistoryImportStatus> {
  const response = await request('history-import', 'POST', { conversation: c })
  expect(response.status).toBe(200)
  return response.json()
}
async function upload(c = fixture().conversation, nodes = fixture().nodes): Promise<HistoryImportStatus> {
  const initial = await start(c)
  const appended = await request(`history-import/${initial.importId}/append`, 'POST', { batch: 0, nodes })
  expect(appended.status).toBe(200)
  const committed = await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 1 })
  expect(committed.status).toBe(200)
  return committed.json()
}
const registry = () => env.PiRegistry.getByName(owner) as DurableObjectStub<PiRegistry>

describe('authenticated archive API and existing search', () => {
  it('atomically makes inert Pi-readable branches visible and searchable without changing main', async () => {
    const main = await registry().ensureDefaultSession()
    const initial = await start()
    expect((await request(`history-archives/${initial.archiveId}`)).status).toBe(404)
    expect(await registry().searchSessions({ query: 'moonflower' })).toEqual([])
    await request(`history-import/${initial.importId}/append`, 'POST', { batch: 0, nodes: fixture().nodes })
    expect(await registry().searchSessions({ query: 'heliotropebranch' })).toEqual([])
    expect((await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 1 })).status).toBe(200)
    const response = await request(`history-archives/${initial.archiveId}?limit=2`)
    expect(response.headers.get('cache-control')).toContain('no-store')
    const page = await response.json() as { nodes: Array<HistoryNode & { message: unknown }>; nextCursor: number }
    expect(page.nodes[0]).toMatchObject(fixture().nodes[0])
    expect(page.nodes[1]).toMatchObject({ ...fixture().nodes[1], message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'privatethoughtquartz' }, { type: 'text', text: 'Moonflowers bloom beside the lantern.' }, { type: 'text', text: '[Historical tool garden_lookup] Archived lookup result; inert.' }] } })
    const next = await request(`history-archives/${initial.archiveId}?cursor=${page.nextCursor}`)
    expect((await next.json() as { nodes: HistoryNode[] }).nodes).toEqual([expect.objectContaining(fixture().nodes[2])])
    await runInDurableObject(registry(), async instance => {
      const tool = createSessionSearchTool(instance)
      const result = await tool.execute({ query: 'heliotropebranch' }, { callId: 'fixture-call' } as never, BACKGROUND_CONTEXT)
      if (result.content![0].type !== 'text') throw new Error('Expected search text')
      expect(JSON.parse(result.content![0].text)).toMatchObject([{ archive: { id: initial.archiveId, conversation: { source: 'deepseek' } }, matches: [{ sourceNodeId: 'answer-b' }] }])
    })
    expect(await registry().searchSessions({ query: 'privatethoughtquartz' })).toEqual([])
    expect(await registry().searchSessions({ query: 're:heliotropebranch' })).toHaveLength(1)
    expect((await registry().listSessions()).map(s => s.id)).not.toContain(initial.archiveId)
    expect(await registry().listSessions({ query: 'moonflower' })).toEqual([])
    expect((await registry().ensureDefaultSession()).id).toBe(main.id)
    expect(await registry().hasReadySession(initial.archiveId)).toBe(false)
    for (const action of ['prompt', 'steer', 'editMessage', 'fork']) {
      expect((await request(`agents/pi-session/${initial.archiveId}/${action}`, 'POST', {})).status).toBe(404)
    }
    expect((await request(`agents//pi-session/${initial.archiveId}/prompt`, 'POST', {})).status).toBe(404)
    const listing = await request('history-archives?limit=1')
    expect(await listing.json()).toMatchObject({ archives: [{ id: initial.archiveId, messageCount: 3 }] })
  })

  it('isolates authoritative hosted instance ownership and requires credentials', async () => {
    expect((await SELF.fetch('http://example.test/api/history-archives')).status).toBe(401)
    expect((await SELF.fetch('http://example.test/api/history-archives', { headers: { authorization: `Basic ${btoa(`fixture:${password}`)}` } })).status).toBe(200)
    const alice = '11111111-1111-4111-8111-111111111111', bob = '22222222-2222-4222-8222-222222222222'
    const hostedEnv = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fictional-internal-secret' }
    async function hosted(instance: string, path: string, method = 'GET', data?: unknown) {
      return server.fetch(new Request(`http://example.test/api/${path}`, { method, headers: { 'x-lamplit-instance': instance, 'x-lamplit-internal-secret': 'fictional-internal-secret', 'content-type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }), hostedEnv)
    }
    const first = await (await hosted(alice, 'history-import', 'POST', { conversation: fixture().conversation })).json() as HistoryImportStatus
    expect((await hosted(bob, `history-import/${first.importId}`)).status).toBe(404)
    expect((await hosted(bob, `agents//pi-registry/${alice}`)).status).toBe(404)
    await hosted(alice, `history-import/${first.importId}/append`, 'POST', { batch: 0, nodes: fixture().nodes })
    await hosted(alice, `history-import/${first.importId}/commit`, 'POST', { batches: 1 })
    expect((await hosted(bob, `history-archives/${first.archiveId}`)).status).toBe(404)
    expect(await (env.PiRegistry.getByName(bob) as DurableObjectStub<PiRegistry>).searchSessions({ query: 'moonflower' })).toEqual([])
    expect((await hosted(alice, 'history-import', 'POST', { conversation: { ...fixture().conversation, instanceId: bob } })).status).toBe(400)
  })
})


describe('incremental import, fixed Rikka role and recovery', () => {
  it('deduplicates re-exports and appends nodes while updating display and selection metadata', async () => {
    const first = await upload()
    const repeat = await upload()
    expect(repeat).toMatchObject({ archiveId: first.archiveId, added: 0 })
    const { conversation, nodes } = fixture()
    conversation.title = 'New display title'; conversation.selectedLeafId = 'answer-b'
    nodes[1].selected = false; nodes[2].selected = true
    const extra = { ...nodes[2], id: 'answer-c', messageId: 'message-c', sourceOrder: 3, selected: false, parts: [{ type: 'text' as const, text: 'incrementalperiwinkle' }] }
    const changed = await upload(conversation, [nodes[1], nodes[2], extra])
    expect(changed).toMatchObject({ archiveId: first.archiveId, added: 1 })
    const page = await (await request(`history-archives/${first.archiveId}`)).json() as { conversation: HistoryConversation; nodes: HistoryNode[]; messageCount: number }
    expect(page.conversation).toEqual(conversation)
    expect(page.messageCount).toBe(4)
    expect(page.nodes.map(n => n.id)).toEqual(['question', 'answer-a', 'answer-b', 'answer-c'])
    expect(page.nodes[1].selected).toBe(false)
    expect(await registry().searchSessions({ query: 'incrementalperiwinkle' })).toHaveLength(1)
  })

  it('retains old archives and successful conversations when any source content conflicts', async () => {
    const first = await upload()
    for (const field of ['parts', 'speaker', 'parentId', 'time', 'messageId'] as const) {
      const { conversation, nodes } = fixture()
      if (field === 'parts') nodes[0].parts = [{ type: 'text', text: 'conflictingchrysanthemum' }]
      if (field === 'speaker') nodes[0].speaker = 'Different speaker'
      if (field === 'parentId') nodes[0].parentId = 'answer-b'
      if (field === 'time') nodes[0].time = nodes[1].time
      if (field === 'messageId') nodes[0].messageId = 'changed-id'
      const pending = await start(conversation)
      await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes })
      const failed = await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 1 })
      expect(failed.status).toBe(409)
      expect(await failed.json()).toMatchObject({ error: { code: 'conflict', sourceNodeId: 'question' } })
      await request(`history-import/${pending.importId}`, 'DELETE')
    }
    expect(await registry().searchSessions({ query: 'conflictingchrysanthemum' })).toEqual([])
    expect((await (await request(`history-archives/${first.archiveId}`)).json() as { nodes: HistoryNode[] }).nodes[0]).toMatchObject(fixture().nodes[0])
    const another = { ...fixture().conversation, conversationId: 'another-conversation' }
    expect((await upload(another)).state).toBe('committed')
    expect((await request(`history-archives/${first.archiveId}`)).status).toBe(200)
  })

  it('resumes batches, rejects changed reuse and retries committed receipt without duplicates', async () => {
    const initial = await start()
    const nodes = fixture().nodes
    const append = (batch: number, values: HistoryNode[]) => request(`history-import/${initial.importId}/append`, 'POST', { batch, nodes: values })
    expect((await append(0, [nodes[0]])).status).toBe(200)
    expect((await append(0, [nodes[0]])).status).toBe(200)
    expect((await append(0, [{ ...nodes[0], speaker: 'Changed' }])).status).toBe(409)
    expect((await append(2, [nodes[1]])).status).toBe(409)
    const status = await (await request(`history-import/${initial.importId}`)).json()
    expect(status).toMatchObject({ state: 'staging', nextBatch: 1, nodeCount: 1 })
    expect(await registry().searchSessions({ query: 'moonflower' })).toEqual([])
    expect((await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 1 })).status).toBe(400) // selected leaf not yet supplied
    expect((await append(1, nodes.slice(1))).status).toBe(200)
    const committed = await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 2 })
    expect(committed.status).toBe(200)
    const again = await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 2 })
    expect(await again.json()).toEqual(await committed.json())
    expect((await append(1, nodes.slice(1))).status).toBe(200)
    expect((await append(2, [nodes[0]])).status).toBe(409)
    expect((await request(`history-import/${initial.importId}`, 'DELETE')).status).toBe(409)
  })

  it('reuses concurrent starts and commits one source archive', async () => {
    const a = await start(), b = await start()
    expect(a).toEqual(b)
    for (const pending of [a, b]) await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: fixture().nodes })
    const results = await Promise.all([a, b].map(s => request(`history-import/${s.importId}/commit`, 'POST', { batches: 1 })))
    const statuses = await Promise.all(results.map(r => r.json() as Promise<HistoryImportStatus>))
    expect(statuses[0].archiveId).toBe(statuses[1].archiveId)
    expect(statuses.map(s => s.added).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([3, 3])
    expect((await (await request('history-archives')).json() as { archives: unknown[] }).archives).toHaveLength(1)
  })

  it('recovers dropped start replies before the pending cap without extending expiry', async () => {
    for (let i = 0; i < 5; i++) expect((await request('history-import', 'POST', { conversation: fixture().conversation })).status).toBe(200) // discard replies, including importId
    const recovered = await start()
    for (let i = 0; i < 3; i++) await start({ ...fixture().conversation, conversationId: `other-${i}` })
    expect(await start()).toEqual(recovered) // reuse even at the four-conversation cap
    expect((await request('history-import', 'POST', { conversation: { ...fixture().conversation, conversationId: 'fifth' } })).status).toBe(413)
    expect((await request(`history-import/${recovered.importId}/append`, 'POST', { batch: 0, nodes: fixture().nodes })).status).toBe(200)
    expect((await request(`history-import/${recovered.importId}/commit`, 'POST', { batches: 1 })).status).toBe(200)
    expect((await request(`history-archives/${recovered.archiveId}`)).status).toBe(200)
    const next = await start()
    expect(next.importId).not.toBe(recovered.importId) // committed receipt is not unfinished staging
  })

  it('preserves resumed metadata and nodes and rejects incompatible starts or batches', async () => {
    const initial = await start()
    const nodes = fixture().nodes
    expect((await request(`history-import/${initial.importId}/append`, 'POST', { batch: 0, nodes: [nodes[0]] })).status).toBe(200)
    const resumed = await start()
    expect(resumed).toMatchObject({ importId: initial.importId, nextBatch: 1, nodeCount: 1, expiresAt: initial.expiresAt })
    for (const change of [{ title: 'Different title' }, { selectedLeafId: null }, { updatedAt: nodes[0].time }]) {
      expect((await request('history-import', 'POST', { conversation: { ...fixture().conversation, ...change } })).status).toBe(409)
    }
    expect((await request(`history-import/${resumed.importId}/append`, 'POST', { batch: 0, nodes })).status).toBe(409) // different chunking is not silently combined
    expect((await request(`history-import/${resumed.importId}/append`, 'POST', { batch: 1, nodes: [{ ...nodes[0], speaker: 'Changed' }] })).status).toBe(409)
    expect((await request(`history-import/${resumed.importId}/append`, 'POST', { batch: 0, nodes: [nodes[0]] })).status).toBe(200)
    expect((await request(`history-import/${resumed.importId}/append`, 'POST', { batch: 1, nodes: nodes.slice(1) })).status).toBe(200)
    expect((await request(`history-import/${resumed.importId}/commit`, 'POST', { batches: 2 })).status).toBe(200)
    expect((await (await request(`history-archives/${resumed.archiveId}`)).json() as { conversation: HistoryConversation; nodes: HistoryNode[] })).toMatchObject({ conversation: fixture().conversation, nodes })
  })

  it('does not bind on start/cancel/failure, then atomically permits only one Rikka role', async () => {
    const imported = (await import('./fixtures/history-rikka.json')).default
    const rikka = structuredClone(imported) as { conversation: HistoryConversation; nodes: HistoryNode[] }
    const cancelled = await start(rikka.conversation)
    await request(`history-import/${cancelled.importId}`, 'DELETE')
    expect(await (await request('history-import')).json()).toEqual({ rikkaAssistantId: null, operitAssistantId: null })
    const invalid = await start(rikka.conversation)
    await request(`history-import/${invalid.importId}/append`, 'POST', { batch: 0, nodes: [{ ...rikka.nodes[0], parentId: 'missing' }] })
    expect((await request(`history-import/${invalid.importId}/commit`, 'POST', { batches: 1 })).status).toBe(400)
    await request(`history-import/${invalid.importId}`, 'DELETE')
    expect(await (await request('history-import')).json()).toEqual({ rikkaAssistantId: null, operitAssistantId: null })
    const roleA = await start(rikka.conversation)
    const roleB = await start({ ...rikka.conversation, assistant: { id: 'fictional-other-role', name: 'Other guide' } })
    for (const pending of [roleA, roleB]) await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: rikka.nodes })
    const results = await Promise.all([roleA, roleB].map(s => request(`history-import/${s.importId}/commit`, 'POST', { batches: 1 })))
    expect(results.map(r => r.status).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([200, 409])
    const bound = await (await request('history-import')).json() as { rikkaAssistantId: string }
    const renamed = { ...rikka.conversation, assistant: { id: bound.rikkaAssistantId, name: 'Renamed guide' } }
    expect((await upload(renamed, rikka.nodes)).added).toBe(0)
    expect((await request('history-import', 'POST', { conversation: { ...rikka.conversation, assistant: undefined } })).status).toBe(400)
    expect((await upload()).state).toBe('committed')
    const successful = await results[results.findIndex(r => r.status === 200)].json() as HistoryImportStatus
    const page = await (await request(`history-archives/${successful.archiveId}`)).json() as { nodes: HistoryNode[] }
    expect(page.nodes[0].time).toEqual(rikka.nodes[0].time)
    expect(page.nodes[0].time.epochMs).toBeUndefined()
  })

  it('rolls back content, FTS and Rikka binding when indexing fails, then allows a retry', async () => {
    const rikka = (await import('./fixtures/history-rikka.json')).default
    const { HistoryArchives } = await import('./history-archives')
    await runInDurableObject(registry(), async (instance, state) => {
      let fail = true
      const archive = new HistoryArchives(state.storage, (id, node) => {
        state.storage.sql.exec('INSERT INTO pi_registry_search_fts VALUES(?,?,?,?,?)', id, node.id, node.role, node.time.raw, 'atomicrollbacktoken')
        if (fail) throw new Error('fictional index failure containing private material')
      })
      const pending = await archive.start({ conversation: rikka.conversation })
      await archive.append(pending.importId, { batch: 0, nodes: rikka.nodes })
      expect(() => archive.commit(pending.importId, { batches: 1 })).toThrow('fictional index failure')
      expect(archive.settings()).toEqual({ rikkaAssistantId: null, operitAssistantId: null })
      expect(archive.list('', 20).archives).toEqual([])
      expect(state.storage.sql.exec('SELECT * FROM pi_registry_search_fts').toArray()).toEqual([])
      expect(await instance.searchSessions({ query: 'atomicrollbacktoken' })).toEqual([])
      fail = false
      expect(archive.commit(pending.importId, { batches: 1 }).state).toBe('committed')
      expect(archive.settings().rikkaAssistantId).toBe('fictional-role-1')
    })
  })

  it('cleans only expired staging and leaves committed data readable and searchable', async () => {
    const committed = await upload()
    const pending = await start({ ...fixture().conversation, conversationId: 'abandoned-conversation' })
    await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: fixture().nodes })
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec('UPDATE history_staging SET expires=0')
    })
    expect((await request(`history-import/${pending.importId}`)).status).toBe(404)
    const restarted = await start()
    await request(`history-import/${restarted.importId}`, 'DELETE')
    expect((await request(`history-archives/${committed.archiveId}`)).status).toBe(200)
    expect(await registry().searchSessions({ query: 'moonflower' })).toHaveLength(1)
    await runInDurableObject(registry(), (_instance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM history_staged_nodes').toArray()).toEqual([])
      expect(state.storage.sql.exec('SELECT * FROM history_batches').toArray()).toEqual([])
    })
  })
})

describe('bounded resources, invalid data and private diagnostics', () => {
  it('bounds streamed bytes before JSON parsing and cancels an over-limit reader', async () => {
    const { boundedJson } = await import('./history-import-api')
    const { HISTORY_LIMITS: limits } = await import('../shared/history-import')
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(limits.requestBytes)); controller.enqueue(new Uint8Array(1)) },
      cancel() { cancelled = true },
    })
    await expect(boundedJson(new Request('http://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream }))).rejects.toMatchObject({ code: 'resource-limit', status: 413 })
    expect(cancelled).toBe(true)
    const response = await request('history-import', 'POST', { padding: 'x'.repeat(limits.requestBytes) })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'resource-limit', issueId: expect.any(String) } })
    expect((await request('history-import', 'POST', { conversation: fixture().conversation })).status).toBe(200)
  })

  it('accepts a maximum-sized SQL node without truncation and rejects one extra UTF-8 byte', async () => {
    const { HISTORY_LIMITS: limits } = await import('../shared/history-import')
    const { jsonBytes } = await import('./history-archives')
    const c = { ...fixture().conversation, selectedLeafId: 'boundary-node' }
    const n = { ...fixture().nodes[0], id: 'boundary-node', messageId: 'boundary-message', parts: [{ type: 'text' as const, text: 'sqlboundaryorchid ' }] }
    n.parts[0].text += 'x'.repeat(limits.nodeBytes - jsonBytes(n))
    expect(jsonBytes(n)).toBe(limits.nodeBytes)
    const pending = await start(c)
    expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: [n] })).status).toBe(200)
    expect((await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 1 })).status).toBe(200)
    const page = await (await request(`history-archives/${pending.archiveId}`)).json() as { nodes: HistoryNode[] }
    expect(page.nodes[0].parts).toEqual(n.parts)
    expect(await registry().searchSessions({ query: 'sqlboundaryorchid' })).toHaveLength(1)
    const second = await start(c)
    n.parts[0].text += 'x'
    const rejected = await request(`history-import/${second.importId}/append`, 'POST', { batch: 0, nodes: [n] })
    expect(rejected.status).toBe(413)
    expect((await (await request(`history-import/${second.importId}`)).json() as HistoryImportStatus).nextBatch).toBe(0)
    expect(page.nodes[0].parts[0]).toEqual({ type: 'text', text: n.parts[0].text.slice(0, -1) })
  })

  it('imports a conversation larger than a request using multiple bounded batches', async () => {
    const { conversation, nodes } = fixture()
    conversation.selectedLeafId = 'long-5'
    const pending = await start(conversation)
    const long = Array.from({ length: 6 }, (_, i) => ({ ...nodes[0], id: `long-${i}`, messageId: `long-message-${i}`, parentId: i ? `long-${i - 1}` : null, sourceOrder: i, parts: [{ type: 'text' as const, text: `longbatchlotus ${i} ` + 'x'.repeat(240_000) }] }))
    for (let i = 0; i < 2; i++) expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: i, nodes: long.slice(i * 3, i * 3 + 3) })).status).toBe(200)
    const committed = await (await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 2 })).json() as HistoryImportStatus
    expect(committed).toMatchObject({ state: 'committed', added: 6 })
    expect(committed.bytes).toBeGreaterThan(1_000_000)
    expect(await registry().searchSessions({ query: 'longbatchlotus' })).toHaveLength(1)
  })

  it('enforces batch, pending-session, total-byte and node-count limits atomically', async () => {
    const { HISTORY_LIMITS: limits } = await import('../shared/history-import')
    const pending = await start()
    const tooMany = Array.from({ length: limits.batchNodes + 1 }, (_, i) => ({ ...fixture().nodes[0], id: `node-${i}` }))
    expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: tooMany })).status).toBe(400)
    // Test-owned metadata fixtures simulate full quotas without allocating 128 MB in a test.
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec('UPDATE history_staging SET bytes=? WHERE id=?', limits.sessionBytes, pending.importId)
    })
    expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: [fixture().nodes[0]] })).status).toBe(413)
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec('UPDATE history_staging SET bytes=0,node_count=? WHERE id=?', limits.sessionNodes, pending.importId)
    })
    expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: [fixture().nodes[0]] })).status).toBe(413)
    const other = await start({ ...fixture().conversation, conversationId: 'quota-other' })
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec('UPDATE history_staging SET bytes=0,node_count=0 WHERE id=?', pending.importId)
      state.storage.sql.exec('UPDATE history_staging SET bytes=? WHERE id=?', limits.pendingBytes, other.importId)
    })
    expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: [fixture().nodes[0]] })).status).toBe(413)
    await start({ ...fixture().conversation, conversationId: 'quota-third' }); await start({ ...fixture().conversation, conversationId: 'quota-fourth' })
    expect((await request('history-import', 'POST', { conversation: { ...fixture().conversation, conversationId: 'quota-fifth' } })).status).toBe(413)
    expect(await registry().searchSessions({ query: 'moonflower' })).toEqual([])
  })

  it('rejects unknown parts, executable shapes, invalid times and graph cycles', async () => {
    for (const mutation of [
      { parts: [{ type: 'toolCall', name: 'exec', arguments: { command: 'anything' } }] },
      { parts: [{ type: 'image', data: 'not-an-image' }] },
      { time: { raw: '2026-02-30T12:00:00Z', interpretation: 'utc', epochMs: Date.parse('2026-02-30T12:00:00Z') } },
      { time: { raw: '2026-09-01T12:00:00', interpretation: 'local-unknown', epochMs: 0 } },
      { time: { raw: '2026-09-01T12:00:00Z', interpretation: 'utc', epochMs: 0 } },
    ]) {
      const pending = await start()
      expect((await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes: [{ ...fixture().nodes[0], ...mutation }] })).status).toBe(400)
      await request(`history-import/${pending.importId}`, 'DELETE')
    }
    const { conversation, nodes } = fixture()
    const pending = await start(conversation)
    nodes[0].parentId = nodes[1].id
    await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes })
    expect((await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 1 })).status).toBe(400)
    expect((await request(`history-archives/${pending.archiveId}`)).status).toBe(404)
    expect(await registry().searchSessions({ query: 'moonflower' })).toEqual([])
  })

  it('logs only allowed diagnostic fields, hashes source IDs and rate-limits events', async () => {
    const { safeDiagnostic } = await import('./history-import-api')
    const event = { source: 'rikka', stage: 'parse', code: 'invalid-format', filename: '../../fictional.zip', member: 'rikka_hub.db', location: { kind: 'db', table: 'message_node', column: 'messages', row: 4, path: [1, 'parts', 2] }, originalBytes: 30_000_000, expandedBytes: 64_000_000, elapsedMs: 123, succeeded: 2, failed: 1, sourceId: 'private-role-identity' }
    const cleaned = await safeDiagnostic(event, 'fictional-issue')
    expect(cleaned).toMatchObject({ issueId: 'fictional-issue', filename: 'fictional.zip', sourceIdHash: expect.stringMatching(/^[0-9a-f]{64}$/), succeeded: 2, failed: 1 })
    expect(JSON.stringify(cleaned)).not.toContain('private-role-identity')
    expect(await safeDiagnostic({ ...event, filename: 'sk-sensitive-secret.zip' }, 'fictional-issue')).not.toHaveProperty('filename')
    for (const field of ['body', 'thought', 'persona', 'apiKey', 'stack', 'exception']) {
      expect((await request('history-import/diagnostics', 'POST', { ...event, [field]: 'PRIVATE_SENTINEL' })).status).toBe(400)
    }
    expect((await request('history-import/diagnostics', 'POST', { ...event, location: 'PRIVATE_SENTINEL' })).status).toBe(400)
    await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec('DELETE FROM history_diagnostic_rate').toArray())
    const first = await request('history-import/diagnostics', 'POST', event)
    expect(first.status).toBe(200)
    const { issueId } = await first.json() as { issueId: string }
    const correlated = await request('history-import/diagnostics', 'POST', { ...event, issueId })
    expect(await correlated.json()).toEqual({ issueId })
    for (let i = 0; i < 8; i++) expect((await request('history-import/diagnostics', 'POST', event)).status).toBe(200)
    expect((await request('history-import/diagnostics', 'POST', event)).status).toBe(429)
    const tooBig = await request('history-import/diagnostics', 'POST', { ...event, extra: 'x'.repeat(4_096) })
    expect(tooBig.status).toBe(413)
  })

  it('accepts real source members and structural positions, rejecting free-form or sensitive locators', async () => {
    for (const event of diagnosticFixtures) {
      expect((await request('history-import/diagnostics', 'POST', event)).status).toBe(200)
      const { safeDiagnostic } = await import('./history-import-api')
      expect(await safeDiagnostic(event, 'fictional-issue')).toMatchObject({ member: event.member, ...(event.location ? { location: event.location } : {}) })
    }
    for (const location of [
      { kind: 'json', path: ['mapping', 'private-source-id', 'message'] },
      { kind: 'json', path: ['mapping', '*', 'message', 'apiKey'] },
      { kind: 'json', path: ['../settings.json'] },
      { kind: 'json', path: ['fragments', -1] },
      { kind: 'json', path: ['fragments', 1.5] },
      { kind: 'json', path: Array(13).fill('message') },
      { kind: 'db', table: 'providers', column: 'password' },
      { kind: 'db', table: 'message_node', column: 'assistant_id' },
      { kind: 'db', table: 'message_node', column: 'messages', row: 'private-source-id' },
    ]) expect((await request('history-import/diagnostics', 'POST', { ...diagnosticFixtures[0], location })).status).toBe(400)
    for (const member of ['deepseek.json', 'rikka.db', '../conversations.json']) expect((await request('history-import/diagnostics', 'POST', { ...diagnosticFixtures[0], member })).status).toBe(400)
  })

  it('retains sanitized Unicode ZIP basenames and strips injection while rejecting secret-shaped names', async () => {
    const { safeDiagnostic } = await import('./history-import-api')
    for (const filename of ['聊天备份.zip', '/fictional/聊天备份.zip', 'C:\\fictional\\聊天备份.zip', '聊天\u202e备份\u0000.zip', '聊天\ufe0f备份.zip']) {
      expect(await safeDiagnostic({ ...diagnosticFixtures[0], filename }, 'fictional-issue')).toHaveProperty('filename', '聊天备份.zip')
    }
    for (const filename of ['हिन्दी.zip', 'தமிழ்.zip', 'عَرَبِي.zip']) {
      expect(await safeDiagnostic({ ...diagnosticFixtures[0], filename }, 'fictional-issue')).toHaveProperty('filename', filename.normalize('NFKC'))
    }
    for (const filename of ['\u0301backup.zip', 'sk-sensitive.zip', 's\u200bk-sensitive.zip', 'ｓｋ-sensitive.zip', 'password备份.zip', '../', '聊天备份.zip.exe', '<script>.zip']) {
      expect(await safeDiagnostic({ ...diagnosticFixtures[0], filename }, 'fictional-issue')).not.toHaveProperty('filename')
    }
  })

  it('rejects cross-origin mutations and keeps error responses private and bounded', async () => {
    const result = await server.fetch(new Request('http://example.test/api/history-import', { method: 'POST', headers: { authorization: `Basic ${btoa(`fixture:${password}`)}`, origin: 'https://other.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ conversation: fixture().conversation }) }), env)
    expect(result.status).toBe(403)
    expect(result.headers.get('cache-control')).toContain('no-store')
    expect(await result.json()).toMatchObject({ error: { code: 'forbidden' } })
    for (const path of ['history-archives?limit=21', 'history-archives?cursor=' + 'x'.repeat(201), 'history-archives/archive-absent?cursor=NaN']) expect((await request(path)).status).toBe(400)
    await runInDurableObject(registry(), async (instance, state) => {
      const spy = (await import('vitest')).vi.spyOn(console, 'info')
      state.storage.sql.exec("CREATE TRIGGER history_test_failure BEFORE INSERT ON history_staging BEGIN SELECT RAISE(ABORT, 'PRIVATE_BODY_AND_SECRET'); END")
      try {
        const response = await instance.historyRequest('start', { input: { conversation: fixture().conversation } })
        expect(response).toMatchObject({ status: 500, body: { error: { code: 'internal-error' } } })
        expect(JSON.stringify(response)).not.toContain('PRIVATE_BODY_AND_SECRET')
        expect(JSON.stringify(spy.mock.calls)).not.toContain('PRIVATE_BODY_AND_SECRET')
      } finally { state.storage.sql.exec('DROP TRIGGER history_test_failure'); spy.mockRestore() }
    })
  })
})

describe('Operit exact-name groups and atomic archives', () => {
  function operit(): { conversation: HistoryConversation; nodes: HistoryNode[] } {
    return structuredClone(operitFixture) as { conversation: HistoryConversation; nodes: HistoryNode[] }
  }
  async function assistant(name: string) {
    const { hashSourceId } = await import('./history-import-api')
    return { id: name === '' ? 'none' : `card:${await hashSourceId(name)}`, name }
  }
  const settings = async () => (await request('history-import')).json()

  it('validates canonical UTF-8 identities, exact whitespace and source-specific fields', async () => {
    const { conversation } = operit()
    expect(await assistant(conversation.assistant!.name)).toEqual(conversation.assistant)
    for (const value of [undefined, { id: 'arbitrary', name: 'Guide' }, { id: 'none', name: '无角色卡' }, { id: conversation.assistant!.id.toUpperCase(), name: conversation.assistant!.name }, { id: conversation.assistant!.id, name: 'Renamed' }, { id: 'none', name: 'x'.repeat(201) }]) {
      expect((await request('history-import', 'POST', { conversation: { ...conversation, assistant: value } })).status).toBe(400)
    }
    for (const name of ['', ' ', '灯园向导 🌙', '无角色卡']) {
      const stage = await start({ ...conversation, assistant: await assistant(name) })
      await request(`history-import/${stage.importId}`, 'DELETE')
    }
    expect((await request('history-import', 'POST', { conversation: { ...fixture().conversation, sourceParentConversationId: 'parent' } })).status).toBe(400)
    expect(await settings()).toEqual(operitFixture.settingsBefore)
  })

  it('rejects escaped lone surrogates before hashing, preserving valid replacement and astral names', async () => {
    const { conversation, nodes } = operit()
    const malformed = ['\ud800', '\ud801', '\udc00', 'Guide\ud800', '\ud800\ud801', '\udc00\ud800']
    const replacement = await assistant('\ufffd')
    expect((await assistant(malformed[0])).id).toBe(replacement.id)
    expect((await assistant(malformed[1])).id).toBe(replacement.id)
    async function rejectMalformed() {
      for (const name of malformed) {
        // request() JSON.stringify sends lone code units as escaped JSON through the real API.
        const response = await request('history-import', 'POST', { conversation: { ...conversation, assistant: await assistant(name) } })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: { code: 'invalid-data' } })
      }
    }
    await rejectMalformed()
    expect(await settings()).toEqual(operitFixture.settingsBefore)
    for (const name of ['\ufffd', 'Guide \ud83c\udf19']) {
      const group = await assistant(name)
      const committed = await upload({ ...conversation, assistant: group }, nodes)
      const page = await (await request(`history-archives/${committed.archiveId}`)).json() as { conversation: HistoryConversation }
      expect(page.conversation.assistant).toEqual(group)
      await rejectMalformed()
      expect(await settings()).toEqual({ rikkaAssistantId: null, operitAssistantId: group.id })
      owner = crypto.randomUUID()
    }
  })

  it('reads missing external parents and all alternatives through API and session_search, without executable ownership', async () => {
    const { conversation, nodes } = operit()
    const pending = await start(conversation)
    await request(`history-import/${pending.importId}/append`, 'POST', { batch: 0, nodes })
    expect(await settings()).toEqual(operitFixture.settingsBefore)
    expect(await registry().searchSessions({ query: 'heliotropevariant' })).toEqual([])
    expect((await request(`history-archives/${pending.archiveId}`)).status).toBe(404)
    const done = await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 1 })
    expect(done.status).toBe(200)
    expect(await settings()).toEqual(operitFixture.settingsAfter)
    const page = await (await request(`history-archives/${pending.archiveId}`)).json() as { conversation: HistoryConversation; nodes: HistoryNode[] }
    expect(page.conversation).toEqual(conversation)
    expect(page.nodes).toEqual(nodes.map(n => expect.objectContaining(n)))
    expect(page.nodes.map(n => n.selected)).toEqual([true, false, true])
    await runInDurableObject(registry(), async instance => {
      const tool = createSessionSearchTool(instance)
      for (const query of ['moonfloweroriginal', 'heliotropevariant']) {
        const result = await tool.execute({ query }, { callId: 'fictional-operit-search' } as never, BACKGROUND_CONTEXT)
        expect(result.content![0].type).toBe('text')
        if (result.content![0].type === 'text') expect(JSON.parse(result.content![0].text)).toMatchObject([{ archive: { id: pending.archiveId, conversation }, matches: [{ sourceNodeId: expect.any(String) }] }])
      }
    })
    expect(await registry().searchSessions({ query: 'operitthoughtquartz' })).toEqual([])
    expect(await registry().searchSessions({ query: 'Archived lookup' })).toEqual([])
    expect(await registry().hasReadySession(pending.archiveId)).toBe(false)
    expect((await request(`agents/pi-session/${pending.archiveId}/prompt`, 'POST', {})).status).toBe(404)
    expect(await (await request(`history-import/${pending.importId}/commit`, 'POST', { batches: 1 })).json()).toEqual(await done.json())
    const originalOwner = owner
    owner = crypto.randomUUID()
    expect((await request(`history-archives/${pending.archiveId}`)).status).toBe(404)
    expect((await request(`history-import/${pending.importId}`)).status).toBe(404)
    expect(await registry().searchSessions({ query: 'heliotropevariant' })).toEqual([])
    expect(await settings()).toEqual(operitFixture.settingsBefore)
    owner = originalOwner
  })

  it('recovers lost starts and batches, deduplicates and appends messages/variants, preserving content on conflict', async () => {
    const { conversation, nodes } = operit()
    const initial = await start(conversation)
    expect(await start(conversation)).toEqual(initial)
    for (let i = 0; i < 2; i++) expect((await request(`history-import/${initial.importId}/append`, 'POST', { batch: 0, nodes })).status).toBe(200)
    expect((await request(`history-import/${initial.importId}/commit`, 'POST', { batches: 1 })).status).toBe(200)
    expect((await upload(conversation, nodes))).toMatchObject({ archiveId: initial.archiveId, added: 0 })
    conversation.selectedLeafId = nodes[1].id
    nodes[1].selected = true; nodes[2].selected = false
    expect((await upload(conversation, nodes)).added).toBe(0)
    const variant = { ...nodes[2], id: 'node:1788249660000:2', selected: false, parts: [{ type: 'text' as const, text: 'newoperitvariant' }] }
    const message = { ...nodes[0], id: 'node:1788249780000:0', messageId: 'message:1788249780000', parentId: nodes[2].id, sourceOrder: 2, parts: [{ type: 'text' as const, text: 'newoperitmessage' }] }
    conversation.selectedLeafId = message.id
    expect((await upload(conversation, [variant, message]))).toMatchObject({ archiveId: initial.archiveId, added: 2 })
    expect(await registry().searchSessions({ query: 'newoperitvariant' })).toHaveLength(1)
    expect(await registry().searchSessions({ query: 'newoperitmessage' })).toHaveLength(1)
    const bad = await start(conversation)
    await request(`history-import/${bad.importId}/append`, 'POST', { batch: 0, nodes: [{ ...nodes[0], parts: [{ type: 'text', text: 'conflictingoperitbody' }] }] })
    const failed = await request(`history-import/${bad.importId}/commit`, 'POST', { batches: 1 })
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: { code: 'conflict' } })
    await request(`history-import/${bad.importId}`, 'DELETE')
    expect(await registry().searchSessions({ query: 'conflictingoperitbody' })).toEqual([])
    const page = await (await request(`history-archives/${initial.archiveId}`)).json() as { nodes: HistoryNode[] }
    expect(page.nodes).toEqual([...nodes, variant, message].map(n => expect.objectContaining(n)))
  })

  it('binds none separately from a real card named 无角色卡 and retains completed conversations after cancellation', async () => {
    const { conversation, nodes } = operit()
    conversation.assistant = await assistant('')
    const cancelled = await start(conversation)
    await request(`history-import/${cancelled.importId}`, 'DELETE')
    const bad = await start(conversation)
    await request(`history-import/${bad.importId}/append`, 'POST', { batch: 0, nodes: [{ ...nodes[0], parentId: 'absent' }] })
    expect((await request(`history-import/${bad.importId}/commit`, 'POST', { batches: 1 })).status).toBe(400)
    expect(await settings()).toEqual(operitFixture.settingsBefore)
    await request(`history-import/${bad.importId}`, 'DELETE')
    const first = await upload(conversation, nodes)
    expect(await settings()).toEqual({ rikkaAssistantId: null, operitAssistantId: 'none' })
    expect((await upload(conversation, nodes)).added).toBe(0)
    const named = await start({ ...conversation, assistant: await assistant('无角色卡') })
    expect(named.archiveId).not.toBe(first.archiveId)
    await request(`history-import/${named.importId}/append`, 'POST', { batch: 0, nodes })
    const response = await request(`history-import/${named.importId}/commit`, 'POST', { batches: 1 })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'role-mismatch' } })
    await request(`history-import/${named.importId}`, 'DELETE')
    expect((await request(`history-archives/${first.archiveId}`)).status).toBe(200)
    expect((await request(`history-archives/${named.archiveId}`)).status).toBe(404)
  })

  it('allows only one competing exact-name binding, independent of Rikka and DeepSeek', async () => {
    const { conversation, nodes } = operit()
    const stages = await Promise.all(['Guide', 'guide'].map(async name => start({ ...conversation, assistant: await assistant(name) })))
    for (const stage of stages) await request(`history-import/${stage.importId}/append`, 'POST', { batch: 0, nodes })
    const replies = await Promise.all(stages.map(stage => request(`history-import/${stage.importId}/commit`, 'POST', { batches: 1 })))
    expect(replies.map(r => r.status).sort((a, b) => a - b)).toEqual([200, 409])
    const bound = await settings() as { operitAssistantId: string }
    for (const name of ['Guide ', 'Another guide', '']) {
      const stage = await start({ ...conversation, assistant: await assistant(name) })
      await request(`history-import/${stage.importId}/append`, 'POST', { batch: 0, nodes })
      expect((await request(`history-import/${stage.importId}/commit`, 'POST', { batches: 1 })).status).toBe(409)
      await request(`history-import/${stage.importId}`, 'DELETE')
    }
    const rikka = (await import('./fixtures/history-rikka.json')).default
    await upload(rikka.conversation as HistoryConversation, rikka.nodes as HistoryNode[])
    await upload()
    expect(await settings()).toEqual({ rikkaAssistantId: 'fictional-role-1', operitAssistantId: bound.operitAssistantId })
  })

  it('rolls back first binding, archive and FTS on index failure and allows a successful retry', async () => {
    const { HistoryArchives } = await import('./history-archives')
    await runInDurableObject(registry(), async (instance, state) => {
      let fail = true
      const archives = new HistoryArchives(state.storage, (id, node) => {
        state.storage.sql.exec('INSERT INTO pi_registry_search_fts VALUES(?,?,?,?,?)', id, node.id, node.role, node.time.raw, 'operitrollbacktoken')
        if (fail) throw new Error('fictional index failure')
      })
      const { conversation, nodes } = operit()
      const pending = await archives.start({ conversation })
      await archives.append(pending.importId, { batch: 0, nodes })
      expect(() => archives.commit(pending.importId, { batches: 1 })).toThrow('fictional index failure')
      expect(archives.settings()).toEqual(operitFixture.settingsBefore)
      expect(archives.list('', 20).archives).toEqual([])
      expect(await instance.searchSessions({ query: 'operitrollbacktoken' })).toEqual([])
      expect(archives.getStatus(pending.importId).state).toBe('staging')
      fail = false
      expect(archives.commit(pending.importId, { batches: 1 })).toMatchObject({ state: 'committed', added: 3 })
      expect(archives.settings()).toEqual(operitFixture.settingsAfter)
    })
  })

  it('accepts controlled JSON diagnostics and source-specific basenames without leaking values', async () => {
    const { safeDiagnostic } = await import('./history-import-api')
    const event = diagnosticFixtures.at(-1)!
    expect((await request('history-import/diagnostics', 'POST', event)).status).toBe(200)
    expect(await safeDiagnostic(event, 'fictional-issue')).toMatchObject({ filename: 'fictional-operit.json', member: 'operit.json', location: event.location })
    for (const filename of ['../聊天备份.json', '聊天\u202e备份.json', '聊天备份\ufe0f.json']) expect(await safeDiagnostic({ ...event, filename }, 'fictional-issue')).toHaveProperty('filename', '聊天备份.json')
    for (const filename of ['export.zip', 'sk-sensitive.json', 'ｓｋ-sensitive.json', 's\u200bk-sensitive.json', 'backup.json.exe']) expect(await safeDiagnostic({ ...event, filename }, 'fictional-issue')).not.toHaveProperty('filename')
    expect(await safeDiagnostic({ ...diagnosticFixtures[0], filename: 'export.json' }, 'fictional-issue')).not.toHaveProperty('filename')
    for (const path of [['chats', 0, 'characterCardName', 'private-role-name'], ['workspace'], ['provider'], ['apiKey'], Array(13).fill('messages')]) expect((await request('history-import/diagnostics', 'POST', { ...event, location: { kind: 'json', path } })).status).toBe(400)
  })
})
