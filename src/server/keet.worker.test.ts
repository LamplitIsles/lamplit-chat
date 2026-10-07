import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendNative, type NativeFixture } from './fixtures/native-session'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import { PiSessionStorage } from './pi-session-storage'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import { parseKeetFrame, type KeetFrame } from './keet-feed'
import { nativeReply } from './fixtures/native-provider'
import worker from '../server'

const registry = () => env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
const frame = (sequence: number, kind: KeetFrame['destination']['kind'], text: string, trigger?: KeetFrame['trigger']): KeetFrame => ({
  type: 'message', eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`, sequence,
  messageId: { deviceId: 'fictional-peer', seq: sequence }, timestamp: sequence, destination: { kind, groupName: kind === 'group' ? 'Room' : 'Peer' }, senderLabel: 'Alice', text,
  ...(trigger ? { trigger } : {}),
})
const request = (event: unknown, token = 'fixture-ingest') => new Request('https://chat.fixture/api/keet/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(event) })
type Internals = NativeFixture & { active: boolean; schedulePendingDrain(): Promise<void>; scheduleMemoryExtraction(): void; env: Env }
afterEach(() => vi.restoreAllMocks())
async function create() {
  const created = await registry().createSession({ name: 'Fictional Keet companion' })
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, instance => {
    const internal = instance as unknown as Internals
    vi.spyOn(internal, 'scheduleMemoryExtraction').mockImplementation(() => {})
    vi.spyOn(internal, 'schedulePendingDrain').mockResolvedValue()
  })
  return { stub, configured: { ...env, COMPANION_SESSION_ID: created.id, KEET_INGEST_TOKEN: 'fixture-ingest' } as Env, id: created.id }
}

describe('native Keet ingress, queue and shared source', () => {
  it('fails closed before session mutation, preserving independent bearer and hosted boundaries', async () => {
    const { configured } = await create()
    expect((await worker.fetch(request(frame(1, 'dm', 'hello', 'dm')), { ...configured, KEET_INGEST_TOKEN: '' })).status).toBe(401)
    expect((await worker.fetch(request(frame(1, 'dm', 'hello', 'dm'), 'wrong'), configured)).status).toBe(401)
    expect((await worker.fetch(request(frame(1, 'dm', 'hello', 'dm')), { ...configured, COMPANION_SESSION_ID: '' })).status).toBe(503)
    expect((await worker.fetch(request(frame(1, 'dm', 'hello', 'dm')), { ...configured, COMPANION_SESSION_ID: crypto.randomUUID() as Env['COMPANION_SESSION_ID'] })).status).toBe(503)
    expect((await worker.fetch(request(frame(1, 'dm', 'hello', 'dm')), { ...configured, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fictional-internal' })).status).toBe(403)
    const trusted = new Request(request(frame(1, 'dm', 'hello', 'dm')))
    trusted.headers.set('x-lamplit-instance', crypto.randomUUID()); trusted.headers.set('x-lamplit-internal-secret', 'fictional-internal')
    expect((await worker.fetch(trusted, { ...configured, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: 'fictional-internal' })).status).toBe(503)
    expect((await worker.fetch(new Request('https://chat.fixture/api/keet/events', { method: 'GET', headers: { authorization: 'Bearer fixture-ingest' } }), configured)).status).toBe(405)
    expect((await worker.fetch(request({ ...frame(1, 'dm', 'hello', 'dm'), text: 'x'.repeat(16001) }), configured)).status).toBe(400)
    expect((await worker.fetch(request({ ...frame(1, 'dm', 'hello', 'dm'), senderLabel: 'bad\nlabel' }), configured)).status).toBe(400)
    const huge = new Request('https://chat.fixture/api/keet/events', { method: 'POST', headers: { authorization: 'Bearer fixture-ingest' }, body: ' '.repeat(112 * 1024 + 1) })
    expect((await worker.fetch(huge, configured)).status).toBe(413)
  })

  it('checkpoints and deduplicates exact events, bounds context and admits triggers only', async () => {
    const { stub, configured } = await create()
    expect((await worker.fetch(request(frame(1, 'group', 'ordinary')), configured)).status).toBe(200)
    expect((await worker.fetch(request(frame(1, 'group', 'ordinary')), configured)).status).toBe(200)
    expect((await worker.fetch(request(frame(1, 'group', 'changed')), configured)).status).toBe(409)
    expect((await worker.fetch(request(frame(3, 'dm', 'gap', 'dm')), configured)).status).toBe(409)
    expect((await worker.fetch(request({ ...frame(2, 'group', 'duplicate'), eventId: frame(1, 'group', '').eventId }), configured)).status).toBe(409)
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      expect(storage.keetCheckpoint()).toBe(1)
      expect(storage.nextKeet()).toBeUndefined()
      for (let n = 2; n <= 10; n++) await storage.admitKeet(frame(n, 'group', `context ${n} ` + 'x'.repeat(600)))
      await storage.admitKeet({ ...frame(11, 'group', 'original', 'mention'), reactionContext: [{ targetMessageId: { deviceId: 'peer', seq: 1 }, targetText: 'native-only context sentinel', emoji: '❤️', externalCount: 2 }] })
      expect(storage.nextKeet()?.source.context).toHaveLength(8)
      expect(storage.nextKeet()?.source.context.every(item => item.text.length === 500)).toBe(true)
      expect(storage.nextKeet()?.prompt).toContain('❤️ ×2')
      expect(storage.nextKeet()?.source.text).toBe('original')
      await storage.admitKeet(frame(12, 'broadcast', 'news'))
      expect(storage.keetCheckpoint()).toBe(12)
      expect(storage.nextKeet()?.sequence).toBe(11)
    })
    expect(() => parseKeetFrame({ ...frame(1, 'dm', 'hi', 'dm'), source: { kind: 'keet' } })).toThrow('Invalid')
  })

  it('publishes original Keet text/source on real sockets while native model requests contain private attribution', async () => {
    const { stub, configured, id } = await create()
    const requests: Array<{ messages: unknown[] }> = []
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { requests.push(JSON.parse(init!.body as string)); return nativeReply('openrouter', 'Native Keet reply') })
    expect((await worker.fetch(request(frame(1, 'group', 'native-only context sentinel')), configured)).status).toBe(200)
    expect((await worker.fetch(request(frame(2, 'group', 'visible original', 'mention')), configured)).status).toBe(200)
    await runInDurableObject(stub, async (instance, state) => {
      const storage = new PiSessionStorage(state.storage), next = storage.nextKeet()!
      await instance.drainPendingWork()
      await (instance as unknown as NativeFixture).native.wait(next.operationId)
      await vi.waitFor(() => expect(storage.nextKeet()).toBeUndefined(), { timeout: 10000 })
      expect((await instance.getBranch()).entries.filter(entry => entry.keet)).toHaveLength(1)
    })
    expect(fake).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(requests[0])).toContain('[Keet Group: Room; sender: Alice;')
    expect(JSON.stringify(requests[0])).toContain('native-only context sentinel')
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...configured, COMPANION_SESSION_ID: id as Env['COMPANION_SESSION_ID'] })
      expect(response.status).toBe(101)
      const socket = response.webSocket!; socket.accept(); let view: ChatView | undefined
      const client = await openChat(socket, next => { view = next }, () => {})
      try {
        expect(view!.messages.find(message => message.source?.kind === 'keet')).toMatchObject({ role: 'user', text: 'visible original', source: { kind: 'keet', channel: 'group', senderLabel: 'Alice', destination: 'Room' } })
        expect(JSON.stringify(view)).not.toContain('native-only context sentinel')
      } finally { client.close(); socket.close() }
    }
  })
  it('reuses committed native Keet admission after a lost domain acknowledgement', async () => {
    const { stub } = await create()
    const fake = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Native Keet reply'))
    await runInDurableObject(stub, async (instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      await storage.admitKeet(frame(1, 'dm', 'restart original', 'dm'))
      const next = storage.nextKeet()!
      await (instance as unknown as NativeFixture).native.submit(next.source.text, { operationId: next.operationId })
      await (instance as unknown as NativeFixture).native.wait(next.operationId)
      await instance.drainPendingWork()
      await vi.waitFor(() => expect(storage.nextKeet()).toBeUndefined(), { timeout: 10000 })
      expect((await instance.getBranch()).entries.filter(entry => entry.keet)).toHaveLength(1)
      await instance.onStart()
      expect((await instance.getBranch()).entries.filter(entry => entry.keet)).toHaveLength(1)
    })
    expect(fake).toHaveBeenCalledTimes(1)
  })
  it.each(['compaction', 'memory'] as const)('retains DM/Group model attribution in native %s and private context stays out of display/search', async maintenance => {
    const { stub, configured } = await create()
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(init!.body as string))
      return nativeReply('openrouter', 'Source-aware continuity', maintenance === 'memory' && new Headers(init?.headers).get('cf-aig-metadata')?.includes('memory-extraction') ? { name: 'record_memory_changes', arguments: { operations: [] } } : false)
    })
    await runInDurableObject(stub, async instance => {
      await instance.updateCompactionSettings({ enabled: true, keepRecentTokens: 4, reserveTokens: 1000 })
      await appendNative(await (instance as unknown as NativeFixture).getLane(), { role: 'user', content: 'web Human base', timestamp: Date.now() }, BACKGROUND_CONTEXT)
    })
    for (const event of [frame(1, 'group', 'native-only context sentinel'), { ...frame(2, 'group', 'Bob original group', 'mention'), senderLabel: 'Bob' }, { ...frame(3, 'dm', 'Bob original DM', 'dm'), senderLabel: 'Bob' }]) {
      expect((await worker.fetch(request(event), configured)).status).toBe(200)
      await runInDurableObject(stub, async (instance, state) => {
        const next = new PiSessionStorage(state.storage).nextKeet()
        if (next) { await instance.drainPendingWork(); await (instance as unknown as NativeFixture).native.wait(next.operationId); await vi.waitFor(() => expect(new PiSessionStorage(state.storage).nextKeet()).toBeUndefined(), { timeout: 10000 }) }
      })
    }
    await runInDurableObject(stub, async (instance, state) => {
      const native = instance as unknown as NativeFixture
      const lane = await native.getLane()
      await appendNative(lane, { role: 'user', content: 'retained web tail ' + 'x'.repeat(3000), timestamp: Date.now() }, BACKGROUND_CONTEXT)
      const before = (await instance.getBranch()).entries
      requests.length = 0
      if (maintenance === 'memory') await (instance as unknown as { extractNextMemoryBatch(): Promise<void> }).extractNextMemoryBatch()
      else await (await native.getHarness()).waitForTask(await lane.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT)
      expect(JSON.stringify(requests)).toContain('[Keet Group: Room; sender: Bob;')
      expect(JSON.stringify(requests)).toContain('[Keet DM: Peer; sender: Bob;')
      expect(JSON.stringify(requests)).toContain('native-only context sentinel')
      expect((await instance.getBranch()).entries.filter(entry => entry.keet)).toEqual(before.filter(entry => entry.keet))
      expect(JSON.stringify(before)).not.toContain('native-only context sentinel')
      const storage = new PiSessionStorage(state.storage)
      expect(storage.entriesInOrder().filter(entry => storage.keetSource(entry.id)).map(entry => storage.keetSource(entry.id)!.text)).toEqual(['Bob original group', 'Bob original DM'])
      expect(storage.getOutbox().some(entry => 'text' in entry && entry.text.includes('native-only context sentinel'))).toBe(false)
    })
  })
})
