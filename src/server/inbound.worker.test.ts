import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, expect, it, vi } from 'vitest'
import worker from '../server'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import { PiSessionStorage } from './pi-session-storage'
import { nativeReply } from './fixtures/native-provider'
import { nativeOptions } from './fixtures/native-harness-options'
import type { NativeFixture } from './fixtures/native-session'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
const matrix = (n: number, body = 'Companion') => ({ type: 'message', room_id: '!room:test', event_id: `$${n}`, sender_id: '@other:test', sender_display_name: 'Alice', body, mentions: [], timestamp: 1790000000000 + n, truncated: false })
const config = { matrix: { webhookToken: 'fixture-matrix-token', aliases: ['Companion'], selfUserId: '@self:test' }, keet: { webhookToken: 'fixture-keet-token' } }
const request = (body: unknown, token = config.matrix.webhookToken) => new Request('https://chat.fixture/api/matrix/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
afterEach(() => vi.restoreAllMocks())
// Unedited bytes captured by producer #3609 from real SDK sync -> local webhook.
const producedReplies = [
  '{"type":"message","room_id":"!room:test","sender_display_name":"","event_id":"$reply-nonown","sender_id":"@other:test","timestamp":1700000000000,"body":"ordinary reply","mentions":[],"reply_to_event_id":"$nonown","truncated":false,"reply_to_sender_id":"@third:test"}',
  '{"type":"message","room_id":"!room:test","sender_display_name":"","event_id":"$reply-unknown","sender_id":"@other:test","timestamp":1700000000000,"body":"ordinary reply","mentions":[],"reply_to_event_id":"$missing","truncated":false}',
  '{"type":"message","room_id":"!room:test","sender_display_name":"","event_id":"$reply-own","sender_id":"@other:test","timestamp":1700000000000,"body":"ordinary reply","mentions":[],"reply_to_event_id":"$own","truncated":false,"reply_to_sender_id":"@self:test"}',
]
async function setup(owner?: string) {
  const registry = env.PiRegistry.getByName(owner ?? 'singleton') as DurableObjectStub<PiRegistry>
  const session = owner ? await registry.ensureDefaultSession() : await registry.createSession({ name: 'Owned inbound fixture' })
  const stub = env.PiSession.getByName(owner ? `${owner}:${session.id}` : session.id) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, instance => {
    vi.spyOn(instance as unknown as { schedulePendingDrain(): Promise<void> }, 'schedulePendingDrain').mockResolvedValue()
    vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
    Reflect.set(instance, 'modelEnvironment', async () => nativeOptions().env)
  })
  return { stub, session, settings: { ...env, COMPANION_SESSION_ID: session.id, CHAT_INTEGRATIONS: JSON.stringify(config) } as Env }
}
it.each(['Free', 'Hosted'])('accepts exact MFA-produced reply bytes through %s native ingress', async mode => {
  const owner = mode === 'Hosted' ? crypto.randomUUID() : undefined
  const { stub, settings: free } = await setup(owner)
  const settings = owner ? { ...free, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-internal', PLATFORM: { fetch: async (_input: RequestInfo | URL) => Response.json({ matrix: { ...config.matrix, aliases: [] } }) } as Fetcher } as Env : { ...free, CHAT_INTEGRATIONS: JSON.stringify({ matrix: { ...config.matrix, aliases: [] } }) }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Synthetic producer reply'))
  for (const [index, body] of producedReplies.entries()) {
    const headers: Record<string, string> = owner ? { 'x-lamplit-instance': owner, 'x-lamplit-internal-secret': 'fixture-internal' } : { authorization: `Bearer ${config.matrix.webhookToken}` }
    const send = () => worker.fetch(new Request('https://chat.fixture/api/matrix/events', { method: 'POST', headers, body }), settings)
    expect((await send()).status).toBe(200); expect((await send()).status).toBe(200)
    await runInDurableObject(stub, async (instance, state) => {
      const store = new PiSessionStorage(state.storage), next = store.nextKeet()
      expect(!!next).toBe(index === 2)
      if (next) {
        expect(JSON.parse(next.source.original!)).toEqual(JSON.parse(body))
        await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId)
        await vi.waitFor(() => expect(store.nextKeet()).toBeUndefined())
        const source = store.keetSource((await instance.getBranch()).entries.find(entry => store.keetSource(entry.id))!.id)!
        expect(source.timestamp).toBe(1700000000000); expect(source.event?.eventId).toBe('$reply-own')
      }
      expect(state.storage.sql.exec('SELECT * FROM inbound_receipts').toArray()).toHaveLength(index + 1)
    })
  }
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('admission never consults MCP, auth precedes body/DO and streamed overflow cancels', async () => {
  const { settings, stub } = await setup()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network permitted'))
  for (const MCP_CONFIG of [undefined, '{broken', JSON.stringify({ singleton: [{ name: 'offline', url: 'https://offline.fixture.invalid' }] })]) expect((await worker.fetch(request(matrix(1)), { ...settings, MCP_CONFIG })).status).toBe(200)
  expect(fetch).not.toHaveBeenCalled()
  let cancelled = false
  const overflow = new Request('https://chat.fixture/api/matrix/events', { method: 'POST', headers: { authorization: `Bearer ${config.matrix.webhookToken}` }, body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(112 * 1024 + 1)) }, cancel() { cancelled = true } }) })
  expect((await worker.fetch(overflow, settings)).status).toBe(413)
  expect(cancelled).toBe(true)
  const forbidden = new Request('https://chat.fixture/api/matrix/events', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: 'invalid' })
  expect((await worker.fetch(forbidden, { ...settings, COMPANION_SESSION_ID: '' })).status).toBe(401)
  await runInDurableObject(stub, (_i, state) => expect(state.storage.sql.exec('SELECT * FROM inbound_receipts').toArray()).toHaveLength(1))
})
it('shares the 64 pending cap and rolls back receipts/context on overflow', async () => {
  const { settings, stub } = await setup()
  for (let n = 0; n < 64; n++) expect((await worker.fetch(request(matrix(n)), settings)).status).toBe(200)
  expect((await worker.fetch(request(matrix(100, 'ordinary context')), settings)).status).toBe(200)
  expect((await worker.fetch(request(matrix(65)), settings)).status).toBe(503)
  const keet = { type: 'message', eventId: crypto.randomUUID(), sequence: 500, messageId: { deviceId: 'peer', seq: 1 }, timestamp: 1, destination: { kind: 'dm', groupName: 'Peer' }, senderLabel: 'Bob', text: 'DM', addressing: { mentionsIdentity: false } }
  expect((await worker.fetch(new Request('https://chat.fixture/api/keet/events', { method: 'POST', headers: { authorization: `Bearer ${config.keet.webhookToken}` }, body: JSON.stringify(keet) }), settings)).status).toBe(503)
  await runInDurableObject(stub, (_i, state) => {
    expect(state.storage.sql.exec('SELECT * FROM inbound_receipts').toArray()).toHaveLength(65)
    expect(state.storage.sql.exec('SELECT * FROM keet_queue').toArray()).toHaveLength(64)
    expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM keet_context').toArray())).toContain('ordinary context')
  })
})
it('admits one Free reply turn with immutable original facts and room-scoped context', async () => {
  const { settings, stub } = await setup()
  const calls: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { calls.push(JSON.parse(init!.body as string)); return nativeReply('openrouter', 'Reply fixture') })
  const own = { ...matrix(304, 'ordinary reply'), reply_to_event_id: '$target', reply_to_sender_id: config.matrix.selfUserId }
  const frames = [
    { ...matrix(300, 'other author context'), reply_to_event_id: '$other', reply_to_sender_id: '@else:test' },
    { ...matrix(301, 'unknown author context'), reply_to_event_id: '$missing' },
    { ...matrix(302, 'foreign room sentinel'), room_id: '!else:test' },
    { ...own, event_id: '$self-echo', sender_id: config.matrix.selfUserId },
    { ...own, event_id: '$blank', body: ' \n\t' },
  ]
  for (const frame of frames) expect((await worker.fetch(request(frame), settings)).status).toBe(200)
  await runInDurableObject(stub, (_i, state) => expect(new PiSessionStorage(state.storage).nextKeet()).toBeUndefined())
  for (const frame of [own, own]) expect((await worker.fetch(request(frame), settings)).status).toBe(200)
  expect((await worker.fetch(request({ ...own, reply_to_sender_id: '@else:test' }), settings)).status).toBe(409)
  await runInDurableObject(stub, async (instance, state) => {
    const store = new PiSessionStorage(state.storage), next = store.nextKeet()!
    expect(JSON.parse(next.source.original!)).toEqual(own)
    expect(next.prompt).toContain('other author context'); expect(next.prompt).toContain('unknown author context')
    expect(next.prompt).not.toContain('foreign room sentinel')
    await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId)
    await vi.waitFor(() => expect(store.nextKeet()).toBeUndefined())
    const reopened = new PiSessionStorage(state.storage)
    expect(state.storage.sql.exec('SELECT * FROM keet_queue').toArray()).toHaveLength(1)
    const entry = (await instance.getBranch()).entries.find(entry => reopened.keetSource(entry.id))!
    expect(JSON.parse(reopened.keetSource(entry.id)!.original!)).toEqual(own)
  })
  expect(calls).toHaveLength(1)
  expect((await worker.fetch(request(own), settings)).status).toBe(200)
  await runInDurableObject(stub, (_i, state) => expect(new PiSessionStorage(state.storage).nextKeet()).toBeUndefined())
})
it('rejects invalid reply facts at HTTP ingress before durable admission', async () => {
  const { settings, stub } = await setup()
  for (const fields of [{ reply_to_sender_id: '@self:test' }, { reply_to_sender_id: '@self:test', reply_to_event_id: '' }, { reply_to_sender_id: '@self:test\n', reply_to_event_id: '$target' }, { reply_to_sender_id: null, reply_to_event_id: '$target' }]) expect((await worker.fetch(request({ ...matrix(310), ...fields }), settings)).status).toBe(400)
  await runInDurableObject(stub, (_i, state) => expect(state.storage.sql.exec('SELECT * FROM inbound_receipts').toArray()).toHaveLength(0))
})
it('classifies identical Hosted reply bytes by each selected owner identity', async () => {
  const owners = [crypto.randomUUID(), crypto.randomUUID()], instances = await Promise.all(owners.map(setup))
  const event = { ...matrix(320, 'ordinary hosted reply'), reply_to_event_id: '$target', reply_to_sender_id: '@self:test' }
  const settings = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-internal', PLATFORM: { fetch: async (input: RequestInfo | URL) => Response.json({ matrix: { ...config.matrix, selfUserId: new Request(input).url.endsWith(owners[0]) ? '@self:test' : '@second:test' } }) } as Fetcher } as Env
  for (const owner of owners) {
    const req = request(event); req.headers.delete('authorization'); req.headers.set('x-lamplit-instance', owner); req.headers.set('x-lamplit-internal-secret', 'fixture-internal')
    expect((await worker.fetch(req, settings)).status).toBe(200)
  }
  for (const [index, { stub }] of instances.entries()) await runInDurableObject(stub, (_i, state) => {
    const store = new PiSessionStorage(state.storage)
    expect(!!store.nextKeet()).toBe(index === 0)
    expect(state.storage.sql.exec('SELECT * FROM inbound_receipts').toArray()).toHaveLength(1)
    expect(state.storage.sql.exec('SELECT * FROM keet_context').toArray()).toHaveLength(index)
  })
})
it('uses only selected Hosted settings and existing owner default, with sanitized failure', async () => {
  const owners = [crypto.randomUUID(), crypto.randomUUID()]
  const instances = await Promise.all(owners.map(setup))
  const selected: string[] = []
  const PLATFORM = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), owner = new URL(req.url).pathname.split('/').at(-1)!
    selected.push(owner); expect(req.headers.get('x-lamplit-internal-secret')).toBe('internal-fixture'); expect(req.redirect).toBe('manual')
    return Response.json({ matrix: { ...config.matrix, aliases: [owner] } })
  } } as Fetcher
  const settings = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'internal-fixture', PLATFORM, CHAT_INTEGRATIONS: JSON.stringify(config), COMPANION_SESSION_ID: instances[0].session.id } as Env
  for (const owner of owners) {
    const req = request(matrix(1, owner)); req.headers.delete('authorization'); req.headers.set('x-lamplit-instance', owner); req.headers.set('x-lamplit-internal-secret', 'internal-fixture')
    expect((await worker.fetch(req, settings)).status).toBe(200)
  }
  expect(selected).toEqual(owners)
  for (const [index, { stub }] of instances.entries()) await runInDurableObject(stub, (_i, state) => expect(new PiSessionStorage(state.storage).nextKeet()?.source.text).toContain(owners[index]))
  const req = request(matrix(1)); req.headers.set('x-lamplit-instance', owners[0]); req.headers.set('x-lamplit-internal-secret', 'internal-fixture')
  const result = await worker.fetch(req, { ...settings, PLATFORM: { ...PLATFORM, fetch: async () => new Response('secret diagnostic', { status: 302, headers: { location: 'https://wrong.invalid' } }) } as Fetcher })
  expect(result.status).toBe(503); expect(await result.text()).not.toContain('secret diagnostic')
})
it('projects truthful Matrix text/time and private context through approved sockets on reopen', async () => {
  const { settings, stub } = await setup()
  const requests: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { requests.push(JSON.parse(init!.body as string)); return nativeReply('openrouter', 'Matrix reply') })
  expect((await worker.fetch(request(matrix(1, 'private sentinel')), settings)).status).toBe(200)
  expect((await worker.fetch(request(matrix(2)), settings)).status).toBe(200)
  expect((await worker.fetch(request({ ...matrix(2), body: 'changed' }), settings)).status).toBe(409)
  await runInDurableObject(stub, async (instance, state) => {
    const store = new PiSessionStorage(state.storage), next = store.nextKeet()!
    await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId)
    await vi.waitFor(() => expect(store.nextKeet()).toBeUndefined())
    expect(store.keetSource((await instance.getBranch()).entries.find(entry => store.keetSource(entry.id))!.id)?.kind).toBe('matrix')
  })
  expect(JSON.stringify(requests)).toContain('private sentinel')
  for (let n = 0; n < 2; n++) {
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), settings)
    const socket = response.webSocket!; socket.accept(); let view: ChatView | undefined
    const client = await openChat(socket, next => { view = next }, () => {})
    const message = view!.messages.find(item => item.role === 'user')!
    expect(message.text).toBe('Companion'); expect(message.source).toEqual({ kind: 'matrix', senderId: '@other:test', senderDisplayName: 'Alice', roomId: '!room:test' }); expect(message.createdAt).toBe(matrix(2).timestamp)
    expect(JSON.stringify(view)).not.toContain('private sentinel'); client.close(); socket.close()
  }
})
it('retains original Matrix names, IDs and multiline body from durable facts on public reopen', async () => {
  const { settings, stub } = await setup()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Fixture reply'))
  const cases = [
    { sender_id: '@other:test', sender_display_name: 'Alice' },
    { sender_id: '@fallback:test', sender_display_name: '' },
    { sender_id: '@' + '😀'.repeat(120) + ':test', sender_display_name: '😀灯'.repeat(80) },
    { sender_id: '@hostile:test', sender_display_name: '<img src=x onerror="unsafe()">' },
  ].map((fields, n) => ({ ...matrix(200 + n, `[Matrix: authored literal]\n\nOriginal **body** ${n}`), ...fields, mentions: ['@self:test'], room_id: '!灯:test' }))
  for (const event of cases) {
    expect((await worker.fetch(request(event), settings)).status).toBe(200)
    await runInDurableObject(stub, async (instance, state) => {
      const store = new PiSessionStorage(state.storage), next = store.nextKeet()!
      await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId)
      await vi.waitFor(() => expect(store.nextKeet()).toBeUndefined())
      const source = store.keetSource((await instance.getBranch()).entries.reverse().find(entry => store.keetSource(entry.id))!.id)!
      expect(JSON.parse(source.original!)).toEqual(event)
      expect(store.keetModelPrompt((await instance.getBranch()).entries.reverse().find(entry => store.keetSource(entry.id))!.id)).toContain('Original **body**')
    })
  }
  for (let n = 0; n < 2; n++) {
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), settings)
    const socket = response.webSocket!; socket.accept(); let view: ChatView | undefined
    const client = await openChat(socket, next => { view = next }, () => {})
    const messages = view!.messages.filter(message => message.source?.kind === 'matrix')
    expect(messages).toHaveLength(cases.length)
    for (const [index, event] of cases.entries()) {
      expect(messages[index]).toMatchObject({ text: event.body, createdAt: event.timestamp, source: { kind: 'matrix', senderId: event.sender_id, senderDisplayName: event.sender_display_name, roomId: event.room_id } })
      expect(Object.keys(messages[index].source!).sort()).toEqual(['kind', 'roomId', 'senderDisplayName', 'senderId'])
    }
    expect(new Set(messages.map(message => message.id)).size).toBe(cases.length)
    client.close(); socket.close()
  }
})
it('keeps Matrix public source and body isolated between two Hosted owners', async () => {
  const owners = [crypto.randomUUID(), crypto.randomUUID()]
  const instances = await Promise.all(owners.map(owner => setup(owner)))
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Fixture reply'))
  const settings = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fixture-internal', PLATFORM: { fetch: async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ matrix: config.matrix }) } as Fetcher } as Env
  for (const [index, owner] of owners.entries()) {
    const event = { ...matrix(900, `Companion original owner ${index}`), sender_display_name: index ? '' : 'Alice', sender_id: `@owner${index}:test` }
    const req = request(event); req.headers.delete('authorization'); req.headers.set('x-lamplit-instance', owner); req.headers.set('x-lamplit-internal-secret', 'fixture-internal')
    expect((await worker.fetch(req, settings)).status).toBe(200)
    await runInDurableObject(instances[index].stub, async (instance, state) => {
      const store = new PiSessionStorage(state.storage), next = store.nextKeet()!
      await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId)
      await vi.waitFor(() => expect(store.nextKeet()).toBeUndefined())
    })
  }
  for (const [index, owner] of owners.entries()) {
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', 'x-lamplit-instance': owner, 'x-lamplit-internal-secret': 'fixture-internal', 'x-lamplit-session-hash': 'a'.repeat(64) } }), settings)
    const socket = response.webSocket!; socket.accept(); let view: ChatView | undefined
    const client = await openChat(socket, next => { view = next }, () => {})
    const messages = view!.messages.filter(message => message.source?.kind === 'matrix')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ text: `Companion original owner ${index}`, source: { kind: 'matrix', senderId: `@owner${index}:test`, senderDisplayName: index ? '' : 'Alice', roomId: '!room:test' } })
    expect(JSON.stringify(view)).not.toContain(`Companion original owner ${1 - index}`)
    client.close(); socket.close()
  }
})
it('keeps buffered reaction snapshots until admission and consumes each snapshot once', async () => {
  const { stub } = await setup()
  const { parseChannelEvent } = await import('./channel-events')
  const { eventIdentity } = await import('./channel-config')
  const reaction = { targetMessageId: { deviceId: 'self', seq: 1 }, targetText: 'Prior own message', emoji: '👍', externalCount: 2 }
  const frame = (n: number, trigger: boolean, reactions = true) => ({ type: 'message', eventId: `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`, sequence: n * 10, messageId: { deviceId: 'peer', seq: n }, timestamp: n, destination: { kind: 'group', groupName: 'Room' }, senderLabel: 'Alice', text: 'original', addressing: { mentionsIdentity: trigger }, ...(reactions ? { reactionContext: [reaction] } : {}) })
  await runInDurableObject(stub, (_instance, state) => {
    const store = new PiSessionStorage(state.storage)
    const admit = (value: unknown) => store.admitInbound('keet', parseChannelEvent('keet', value, { webhookToken: '', aliases: [] }), eventIdentity(value))
    admit(frame(1,false)); expect(state.storage.sql.exec('SELECT * FROM inbound_reactions').toArray()).toHaveLength(0)
    admit(frame(2,true,false)); const first = store.nextKeet()!; expect(first.prompt).toContain('👍 ×2')
    store.acceptKeet(first.sequence,'owned-reaction-entry-1'); store.settleKeet(first.sequence)
    admit(frame(3,true)); expect(store.nextKeet()!.prompt).not.toContain('👍 ×2')
    expect(state.storage.sql.exec('SELECT * FROM inbound_reactions').toArray()).toHaveLength(1)
  })
})
