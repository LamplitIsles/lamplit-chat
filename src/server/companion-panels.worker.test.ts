import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import worker from '../server'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import { PiSessionStorage } from './pi-session-storage'
import type { AlbumPage, DiaryPage, RelationshipHistory, Reminders } from '@lamplit/contracts'

const authorization = `Basic ${btoa('owner:fixture-password-long-enough')}`
async function fixture() {
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const metadata = await registry.createSession({ name: 'Panel native fixture' })
  const stub = env.PiSession.getByName(metadata.id) as DurableObjectStub<PiSession>
  const bindings = { ...env, COMPANION_SESSION_ID: metadata.id } as Env
  const open = async () => {
    const response = await worker.fetch(new Request('http://panels.fixture/api/chat/socket', { headers: { authorization, origin: 'http://panels.fixture', upgrade: 'websocket' } }), bindings)
    expect(response.status).toBe(101)
    const socket = response.webSocket!; socket.accept()
    const frames: Array<{ id: string; type: string; result?: unknown }> = []
    socket.addEventListener('message', event => { frames.push(JSON.parse(String(event.data))) })
    let serial = 0
    const call = async (member: string, input: unknown = { sessionId: metadata.id }) => {
      const id = String(++serial)
      socket.send(JSON.stringify({ type: 'call', version: 1, id, call: { serviceId: 'lamplit.chat.v1', member, args: [input] } }))
      await vi.waitFor(() => expect(frames.some(frame => frame.id === id)).toBe(true))
      return frames.find(frame => frame.id === id)!
    }
    return { socket, call }
  }
  return { registry, metadata, stub, bindings, open }
}

it('reads native registry and workspace via authenticated RPC with bounded pages, isolation and recoverable errors', async () => {
  const f = await fixture(), other = await fixture()
  const dates = Array.from({ length: 35 }, (_, i) => new Date(Date.UTC(2026, 9, 2) - i * 86400000).toISOString().slice(0, 10) + '.md')
  const exact = '灯'.repeat(43690) + 'xx'
  expect(new TextEncoder().encode(exact).byteLength).toBe(128 * 1024)
  await f.stub.importSession({ metadata: { id: f.metadata.id, createdAt: f.metadata.createdAt, updatedAt: f.metadata.updatedAt, lineage: { type: 'new' } }, entries: [],
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }, files: [
      ...dates.map((name, i) => ({ path: `/memory/${name}`, content: i === 0 ? exact : i === 1 ? exact + 'x' : '# Native diary' })),
      { path: '/memory/notes.md', content: 'private' }, { path: '/USER.md', content: 'private' },
    ] })
  for (let i = 0; i < 25; i++) await f.registry.updateRelationship({ affinity: { delta: 1, reason: `Native change ${i}` } })
  let client = await f.open()
  const b = await other.open()
  try {
    const first = (await client.call('relationshipHistory', { sessionId: f.metadata.id, cursor: null })).result as RelationshipHistory
    expect(first.records).toHaveLength(20); expect(first.predecessor).toBeDefined(); expect(first.nextCursor).toBeTruthy()
    const second = (await client.call('relationshipHistory', { sessionId: f.metadata.id, cursor: first.nextCursor })).result as RelationshipHistory
    expect(second.records[0]).toEqual(first.predecessor); expect(second.records).toHaveLength(5); expect(second.nextCursor).toBeNull()
    expect((await b.call('relationshipHistory', { sessionId: other.metadata.id, cursor: first.nextCursor })).type).toBe('error')
    expect((await client.call('diaryList', { sessionId: f.metadata.id, cursor: first.nextCursor })).type).toBe('error')
    const page = (await client.call('diaryList', { sessionId: f.metadata.id, cursor: null })).result as DiaryPage
    expect(page.entries).toEqual(dates.slice(0, 30))
    expect((await client.call('diaryList', { sessionId: f.metadata.id, cursor: page.nextCursor })).result).toEqual({ entries: dates.slice(30), nextCursor: null })
    expect((await b.call('diaryList', { sessionId: other.metadata.id, cursor: null })).result).toEqual({ entries: [], nextCursor: null })
    expect((await client.call('diaryRead', { sessionId: f.metadata.id, name: dates[0] })).result).toEqual({ status: 'found', name: dates[0], text: exact })
    expect((await client.call('diaryRead', { sessionId: f.metadata.id, name: dates[1] })).result).toEqual({ status: 'too-large', name: dates[1] })
    expect((await client.call('diaryRead', { sessionId: f.metadata.id, name: '2000-01-01.md' })).result).toEqual({ status: 'missing', name: '2000-01-01.md' })
    for (const name of ['../USER.md', 'notes.md']) expect((await client.call('diaryRead', { sessionId: f.metadata.id, name })).type).toBe('error')
    expect((await client.call('reminders', { sessionId: other.metadata.id })).type).toBe('error')
    // Output schema failure stays a call error, then the same socket recovers.
    await runInDurableObject(f.stub, instance => { vi.spyOn(instance, 'listTimedWakes').mockResolvedValue([{ id: 'bad' } as never]) })
    expect((await client.call('reminders')).type).toBe('error')
    await runInDurableObject(f.stub, () => { vi.restoreAllMocks() })
    expect((await client.call('reminders')).result).toEqual({ reminders: [] })
    client.socket.close(); client = await f.open()
    expect((await client.call('diaryList', { sessionId: f.metadata.id, cursor: page.nextCursor })).result).toEqual({ entries: dates.slice(30), nextCursor: null })
    await f.registry.updateRelationship({ signature: { value: 'native MCP change', reason: 'visible to both sessions' } })
    expect((await b.call('relationship')).result).toMatchObject({ current: { signature: 'native MCP change' } })
    expect((await client.call('relationship')).result).toEqual((await b.call('relationship')).result)
    expect((await runInDurableObject(f.stub, instance => instance.getBranch())).entries).toEqual([])
  } finally { client.socket.close(); b.socket.close(); vi.restoreAllMocks() }
})

it('rejects date-named file aliases and linked memory directories in the real workspace', async () => {
  const f = await fixture()
  await runInDurableObject(f.stub, async instance => {
    const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
    await workspace.mkdir('/workspace/memory', { recursive: true })
    await workspace.mkdir('/workspace/private', { recursive: true })
    await workspace.writeFile('/workspace/private/2026-10-02.md', 'Private sentinel')
    await workspace.fs.symlink('/workspace/private/2026-10-02.md', '/workspace/memory/2026-10-02.md')
  })
  const a = await f.open()
  try {
    expect((await a.call('diaryRead', { sessionId: f.metadata.id, name: '2026-10-02.md' })).result).toEqual({ status: 'missing', name: '2026-10-02.md' })
    expect((await a.call('diaryList', { sessionId: f.metadata.id, cursor: null })).result).toEqual({ entries: [], nextCursor: null })
    await runInDurableObject(f.stub, async instance => {
      const workspace = Reflect.get(instance, 'workspace') as import('./computer-workspace').ComputerWorkspace
      await workspace.rm('/workspace/memory', { recursive: true })
      await workspace.fs.symlink('/workspace/private', '/workspace/memory')
    })
    expect((await a.call('diaryList', { sessionId: f.metadata.id, cursor: null })).result).toEqual({ entries: [], nextCursor: null })
    expect((await a.call('diaryRead', { sessionId: f.metadata.id, name: '2026-10-02.md' })).result).toEqual({ status: 'missing', name: '2026-10-02.md' })
    expect((await a.call('reminders')).result).toEqual({ reminders: [] })
  } finally { a.socket.close() }
})

it('projects registered images with stable createdAt/id ordering, actual availability and authenticated bytes', async () => {
  const f = await fixture(), other = await fixture()
  const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xd9))
  const png = new Uint8Array([137,80,78,71,13,10,26,10])
  const ids = Array.from({ length: 35 }, () => crypto.randomUUID()).sort().reverse()
  for (const id of ids) {
    const operationId = crypto.randomUUID()
    await f.stub.uploadPhoto({ operationId, id, order: 0, name: 'fixture.png', mediaType: 'image/png', original: btoa(String.fromCharCode(...png)), preview: jpeg, model: jpeg })
    await runInDurableObject(f.stub, (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      storage.admitPromptSubmission(operationId, 'native photo fixture', [id]); storage.acceptPromptSubmission(operationId, `entry-${id}`)
      state.storage.sql.exec('UPDATE conversation_photos SET created_at = ? WHERE id = ?', 123456, id)
    })
  }
  await env.COMPUTER_R2!.delete(`conversation-photos/${f.metadata.id}/${ids[1]}/original`)
  const privateId = crypto.randomUUID()
  await f.stub.uploadPhoto({ operationId: crypto.randomUUID(), id: privateId, order: 0, name: 'unregistered.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg })
  const a = await f.open(), b = await other.open()
  try {
    const first = (await a.call('album', { sessionId: f.metadata.id, cursor: null })).result as AlbumPage
    expect(first.images.map(image => image.id)).toEqual(ids.slice(0, 30))
    expect(first.images[1]).toMatchObject({ available: false, originalUrl: null })
    const last = (await a.call('album', { sessionId: f.metadata.id, cursor: first.nextCursor })).result as AlbumPage
    expect(last.images.map(image => image.id)).toEqual(ids.slice(30)); expect(last.nextCursor).toBeNull()
    expect((await b.call('album', { sessionId: other.metadata.id, cursor: first.nextCursor })).type).toBe('error')
    expect((await b.call('album', { sessionId: other.metadata.id, cursor: null })).result).toEqual({ images: [], nextCursor: null })
    const url = `http://panels.fixture${first.images[0].originalUrl}`
    expect((await worker.fetch(new Request(url), f.bindings)).status).toBe(401)
    const bytes = await worker.fetch(new Request(url, { headers: { authorization } }), f.bindings)
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(png)
    expect((await worker.fetch(new Request(url.replace(f.metadata.id, other.metadata.id), { headers: { authorization } }), other.bindings)).status).toBe(404)
    expect((await worker.fetch(new Request(url.replace(ids[0], privateId), { headers: { authorization } }), f.bindings)).status).toBe(404)
    expect((await worker.fetch(new Request(url.replace(ids[0], 'invalid'), { headers: { authorization } }), f.bindings)).status).toBe(404)
  } finally { a.socket.close(); b.socket.close() }
})

it('reads native schedules including pre-Unix anchors without starting a turn', async () => {
  const f = await fixture()
  const at = new Date(Date.now() + 86400000).toISOString()
  for (const plan of [{ type: 'once' as const, at }, { type: 'interval' as const, anchor: '1969-12-31T23:59:59Z', seconds: 90 },
    { type: 'daily' as const, time: '09:30', timeZone: 'Asia/Shanghai' }, { type: 'weekly' as const, time: '20:00', timeZone: 'Asia/Shanghai', weekday: 0 }]) {
    await f.stub.saveTimedWake({ title: 'Native tool reminder', reminder: 'Drink water', plan })
  }
  const a = await f.open()
  try {
    const result = (await a.call('reminders')).result as Reminders
    expect(result.reminders).toHaveLength(4)
    expect(result.reminders.map(r => r.schedule)).toEqual(expect.arrayContaining([
      { kind: 'interval', anchor: -1000, everySeconds: 90 }, { kind: 'weekly', hour: 20, minute: 0, timeZone: 'Asia/Shanghai', weekday: 0 },
    ]))
    expect((await runInDurableObject(f.stub, instance => instance.getBranch())).entries).toEqual([])
    await f.stub.cancelTimedWake(result.reminders[0].id)
    expect(((await a.call('reminders')).result as Reminders).reminders).toHaveLength(3)
  } finally { a.socket.close() }
})

it('rechecks hosted platform authorization for panel calls and isolates instance image storage', async () => {
  const instanceId = crypto.randomUUID(), otherInstanceId = crypto.randomUUID(), sessionId = crypto.randomUUID()
  const stub = env.PiSession.getByName(`${instanceId}:${sessionId}`) as DurableObjectStub<PiSession>
  const other = env.PiSession.getByName(`${otherInstanceId}:${sessionId}`) as DurableObjectStub<PiSession>
  const metadata = { id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' as const } }
  await stub.initialize(metadata); await other.initialize(metadata)
  await stub.fetch(new Request('http://hosted.fixture/'))
  await other.fetch(new Request('http://hosted.fixture/'))
  const photoId = crypto.randomUUID(), operationId = crypto.randomUUID()
  const jpeg = btoa(String.fromCharCode(0xff,0xd8,0xff,0xd9))
  let active = true, checks = 0
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { env: Env }
    internal.env = { ...internal.env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-internal-secret', PLATFORM: { fetch: async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/internal/chat-model/')) return Response.json({ provider: 'openrouter', model: 'openai/gpt-4o', apiKey: 'test-owned-panel-key', thinkingLevel: null, maxOutputTokens: null })
      if (url.includes('/internal/chat-search/')) return Response.json({ enabled: false })
      checks++; return Response.json({ active })
    }, connect: () => { throw new Error('Fixture has no TCP transport') } } } as Env
    await instance.uploadPhoto({ id: photoId, operationId, order: 0, name: 'private.jpg', mediaType: 'image/jpeg', original: jpeg, preview: jpeg, model: jpeg })
    const storage = new PiSessionStorage(state.storage)
    storage.admitPromptSubmission(operationId, 'instance fixture', [photoId]); storage.acceptPromptSubmission(operationId, 'native-entry')
  })
  await runInDurableObject(other, instance => {
    const internal = instance as unknown as { env: Env }
    internal.env = { ...internal.env, HOSTED_MODE: 'true' } as Env
  })
  expect(await env.COMPUTER_R2!.head(`instances/${instanceId}/conversation-photos/${sessionId}/${photoId}/original`)).not.toBeNull()
  expect((await other.readConversationPhoto(photoId, 'original')).status).toBe(404)
  const response = await stub.fetch(new Request('http://hosted.fixture/api/chat/socket', { headers: { upgrade: 'websocket', 'x-lamplit-session-hash': 'a'.repeat(64) } }))
  expect(response.status).toBe(101)
  const socket = response.webSocket!; socket.accept()
  const frames: Array<{ id: string; type: string; result?: unknown }> = []
  socket.addEventListener('message', event => { frames.push(JSON.parse(String(event.data))) })
  try {
    socket.send(JSON.stringify({ type: 'call', version: 1, id: 'allowed', call: { serviceId: 'lamplit.chat.v1', member: 'album', args: [{ sessionId, cursor: null }] } }))
    await vi.waitFor(() => expect(frames.some(f => f.id === 'allowed')).toBe(true))
    expect(frames.find(f => f.id === 'allowed')).toMatchObject({ type: 'result', result: { images: [expect.objectContaining({ id: photoId })] } })
    const previous = checks
    active = false
    socket.send(JSON.stringify({ type: 'call', version: 1, id: 'revoked', call: { serviceId: 'lamplit.chat.v1', member: 'diaryList', args: [{ sessionId, cursor: null }] } }))
    await vi.waitFor(() => expect(checks).toBeGreaterThan(previous))
    expect(frames.some(f => f.id === 'revoked' && f.type === 'result')).toBe(false)
    await vi.waitFor(() => expect(socket.readyState).toBeGreaterThanOrEqual(2))
  } finally { socket.close(); vi.restoreAllMocks() }
})
