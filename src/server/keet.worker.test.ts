import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMPACTION_SETTINGS, type AgentLane } from '@earendil-works/pi-agent-core'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import { laneState } from '@earendil-works/pi-agent-core/harness/session'
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
type Internals = { active: boolean; getLane(): Promise<AgentLane>; schedulePendingDrain(): Promise<void>; scheduleMemoryExtraction(): void; env: Env }
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

  it('queues behind held native web work, projects private model context and publishes original source on real sockets', async () => {
    const { stub, configured, id } = await create()
    const requests: Array<{ messages: unknown[]; tools: Array<{ function: { name: string } }> }> = []
    const original = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith('https://openrouter.ai/')) return original(input, init)
      if (typeof init?.body !== 'string') throw new Error('Expected fictional provider JSON')
      requests.push(JSON.parse(init.body))
      return nativeReply('openrouter', 'Fictional native reply')
    })
    await runInDurableObject(stub, async instance => {
      const lane = await (instance as unknown as Internals).getLane()
      const admitted = await lane.accept({ kind: 'prompt', operationId: crypto.randomUUID(), prompt: 'ordinary held web turn' }, BACKGROUND_CONTEXT)
      if (!admitted.ok) throw admitted.error
    })
    expect((await worker.fetch(request(frame(1, 'group', 'native-only context sentinel')), configured)).status).toBe(200)
    expect((await worker.fetch(request(frame(2, 'group', 'visible original', 'mention')), configured)).status).toBe(200)
    await runInDurableObject(stub, async (instance, state) => {
      await instance.drainPendingWork()
      expect(new PiSessionStorage(state.storage).nextKeet()?.state).toBe('pending')
      const lane = await (instance as unknown as Internals).getLane()
      const current = await lane.inspectExecution(BACKGROUND_CONTEXT)
      if (!current.current) throw new Error('Expected held native work')
      const driven = await lane.drive({ operationId: current.current.id }, BACKGROUND_CONTEXT)
      if (!driven.ok) throw driven.error
      await instance.drainPendingWork()
      expect(new PiSessionStorage(state.storage).nextKeet()).toBeUndefined()
      expect((await instance.getBranch()).entries.filter(e => e.keet)).toHaveLength(1)
    })
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Recent group context:')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('native-only context sentinel')
    expect(requests.at(-1)?.tools.some(tool => tool.function.name.startsWith('keet_'))).toBe(false)
    const open = async () => {
      const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...configured, COMPANION_SESSION_ID: id as Env['COMPANION_SESSION_ID'] })
      expect(response.status).toBe(101); const socket = response.webSocket!; socket.accept(); return socket
    }
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const socket = await open(); let view: ChatView | undefined
      const client = await openChat(socket, next => { view = next }, () => {})
      try {
        await vi.waitFor(() => expect(view?.messages.some(m => m.source?.kind === 'keet')).toBe(true))
        const message = view!.messages.find(m => m.source?.kind === 'keet')!
        expect(message).toMatchObject({ role: 'user', text: 'visible original', source: { kind: 'keet', channel: 'group', senderLabel: 'Alice', destination: 'Room' } })
        expect(JSON.stringify(view)).not.toContain('native-only context sentinel')
      } finally { client.close(); socket.close() }
    }
    await runInDurableObject(stub, async (_instance, state) => {
      const reconstructed = new PiSessionStorage(state.storage)
      const sourceEntry = reconstructed.entriesInOrder().find(e => reconstructed.keetSource(e.id))!
      expect(reconstructed.keetSource(sourceEntry.id)?.text).toBe('visible original')
      expect(reconstructed.getOutbox().some(e => 'text' in e && e.text.includes('native-only context sentinel'))).toBe(false)
    })
  })

  it('recovers a committed native admission with lost source acknowledgement without replay', async () => {
    const { stub } = await create()
    await runInDurableObject(stub, async (instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      await storage.admitKeet(frame(1, 'dm', 'restart original', 'dm'))
      const next = storage.nextKeet()!
      const lane = await (instance as unknown as Internals).getLane()
      const admission = await lane.accept({ kind: 'prompt', operationId: next.operationId, prompt: next.source.text }, BACKGROUND_CONTEXT)
      if (!admission.ok) throw admission.error
      const accept = vi.spyOn(lane, 'accept')
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(nativeReply('openrouter'))
      await instance.drainKeetQueue()
      expect(accept).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(storage.nextKeet()).toBeUndefined()
      expect((await instance.getBranch()).entries.filter(e => e.keet)).toHaveLength(1)
      const entry = (await instance.getBranch()).entries.find(e => e.keet)!
      expect(new PiSessionStorage(state.storage).keetSource(entry.id)?.text).toBe('restart original')
    })
  })

  it('restores a native open Keet operation on start and executes configured tools through fake MCP', async () => {
    const { stub } = await create()
    const calls: string[] = []
    const requests: string[] = []
    let modelCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith('https://openrouter.ai/')) {
        if (typeof init?.body !== 'string') throw new Error('Expected model JSON')
        requests.push(init.body)
        return nativeReply('openrouter', 'Configured native tool reply', ++modelCalls === 1 ? { name: 'keet_list_members', arguments: { destinationName: 'Room' } } : false)
      }
      if (url !== 'https://keet.fixture.invalid/mcp') throw new Error('Fixture forbids external services')
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      if (init?.method === 'DELETE') return new Response(null, { status: 200 })
      if (typeof init?.body !== 'string') throw new Error('Expected MCP JSON')
      const message = JSON.parse(init.body)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fictional-mcp')
      if (message.id === undefined) return new Response(null, { status: 202 })
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fictional', version: '1' } }
        : { content: [{ type: 'text', text: JSON.stringify(message.params.name === 'list_destinations' ? { destinations: [{ destinationName: 'Room' }] } : { members: ['Alice'] }) }] }
      if (message.params?.name) calls.push(message.params.name)
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'mcp-session-id': 'fictional-session' } })
    })
    await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as Internals
      internal.env.KEET_MCP_URL = 'https://keet.fixture.invalid/mcp'
      internal.env.KEET_MCP_TOKEN = 'fictional-mcp'
      const storage = new PiSessionStorage(state.storage)
      await storage.admitKeet(frame(1, 'dm', 'restart configured tools', 'dm'))
      const row = storage.nextKeet()!
      const lane = await internal.getLane()
      const admitted = await lane.accept({ kind: 'prompt', operationId: row.operationId, prompt: row.source.text }, BACKGROUND_CONTEXT)
      if (!admitted.ok) throw admitted.error
      // Model a restart after Pi admission but before source acknowledgement.
      await instance.onStart()
      await vi.waitFor(() => expect(internal.active).toBe(false), { timeout: 10000 })
      expect(new PiSessionStorage(state.storage).nextKeet()).toBeUndefined()
      expect((await instance.getBranch()).entries.filter(e => e.keet)).toHaveLength(1)
      internal.env.KEET_MCP_URL = undefined; internal.env.KEET_MCP_TOKEN = undefined
    })
    expect(calls).toEqual(['list_destinations', 'list_members'])
    for (const name of ['keet_list_destinations', 'keet_list_members', 'keet_read_recent_messages', 'keet_send_message']) expect(requests[0]).toContain(name)
  })

  it('claims queue ownership before awaiting the lane and retains image-only unavailable input', async () => {
    const { stub } = await create()
    await runInDurableObject(stub, async (instance, state) => {
      const storage = new PiSessionStorage(state.storage)
      await storage.admitKeet({ ...frame(1, 'dm', '', 'dm'), images: [{ status: 'unavailable', mediaType: 'image/png' }] })
      expect(storage.nextKeet()?.source.text).toContain('image unavailable')
      const internal = instance as unknown as Internals
      const lane = await internal.getLane()
      let release!: (lane: AgentLane) => void
      const getLane = vi.spyOn(internal, 'getLane').mockReturnValue(new Promise(resolve => { release = resolve }))
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(nativeReply('openrouter'))
      const first = instance.drainKeetQueue()
      expect(internal.active).toBe(true)
      await instance.drainPendingWork(); await instance.drainKeetQueue()
      expect(getLane).toHaveBeenCalledTimes(1)
      release(lane); await first
      expect(storage.nextKeet()).toBeUndefined()
      expect(new PiSessionStorage(state.storage).getValueSync(laneState('main'))?.value.currentOperationId ?? null).toBeNull()
    })
  })

  it.each(['compaction', 'memory', 'summary'] as const)('preserves DM/Group attribution in native %s requests without changing visible entries', async maintenance => {
    const { stub, configured } = await create()
    const requests: Array<{ messages: Array<{ role: string; content: string | Array<{ text: string }> }> }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith('https://openrouter.ai/')) throw new Error('Fixture forbids external requests')
      requests.push(JSON.parse(init!.body as string))
      return nativeReply('openrouter', 'Source-aware checkpoint', maintenance === 'memory' &&
        new Headers(init?.headers).get('cf-aig-metadata')?.includes('memory-extraction')
        ? { name: 'record_memory_changes', arguments: { operations: [] } } : false)
    })
    let target = '', oldTip = ''
    await runInDurableObject(stub, async (instance, state) => {
      new PiSessionStorage(state.storage).setSetting('compaction', { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1, reserveTokens: 1000 })
      target = await (await (instance as unknown as Internals).getLane()).appendMessage({ role: 'user', content: 'web Human base', timestamp: Date.now() }, BACKGROUND_CONTEXT)
    })
    const group = { ...frame(2, 'group', 'Bob original group', 'mention'), senderLabel: 'Bob' }
    const dm = { ...frame(3, 'dm', 'Bob original DM', 'dm'), senderLabel: 'Bob' }
    for (const event of [frame(1, 'group', 'native-only context sentinel'), group, dm]) {
      expect((await worker.fetch(request(event), configured)).status).toBe(200)
      await runInDurableObject(stub, instance => instance.drainKeetQueue())
    }
    await runInDurableObject(stub, async (instance, state) => {
      const lane = await (instance as unknown as Internals).getLane()
      // Same display text from the web must remain web input in memory extraction.
      await lane.appendMessage({ role: 'user', content: dm.text, timestamp: Date.now() + 1 }, BACKGROUND_CONTEXT)
      oldTip = (await lane.getTipId(BACKGROUND_CONTEXT))!
      const before = (await instance.getBranch(oldTip)).entries
      requests.length = 0
      if (maintenance === 'memory') {
        await (instance as unknown as { extractNextMemoryBatch(): Promise<void> }).extractNextMemoryBatch()
      } else if (maintenance === 'summary') {
        const result = await lane.navigateTree(target, { summarize: true }, BACKGROUND_CONTEXT)
        if (!result.ok) throw result.error
      } else {
        const result = await lane.compact(undefined, BACKGROUND_CONTEXT)
        if (!result.ok) throw result.error
        expect(result.value.compaction.status).toBe('completed')
      }
      const serialized = JSON.stringify(requests)
      expect(serialized).toContain('[Keet Group: Room; sender: Bob;')
      expect(serialized).toContain('[Keet DM: Peer; sender: Bob;')
      expect(serialized).toContain('native-only context sentinel')
      if (maintenance === 'memory') {
        const content = requests[0].messages.find(message => message.role === 'user')!.content
        const transcript = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join('')).newTranscriptEntries as Array<{ id: string; text: string }>
        const storage = new PiSessionStorage(state.storage)
        for (const entry of storage.entriesInOrder().filter(e => storage.keetSource(e.id))) {
          expect(transcript.find(item => item.id === entry.id)?.text).toBe(storage.keetModelPrompt(entry.id))
        }
        expect(transcript.find(item => item.id === oldTip)?.text).toBe(dm.text)
        expect(transcript.find(item => item.id === target)?.text).toBe('web Human base')
      }
      expect((await instance.getBranch(oldTip)).entries).toEqual(before)
      const visible = before.filter(e => e.keet)
      expect(visible.map(e => e.keet!.text)).toEqual([group.text, dm.text])
      expect(JSON.stringify(before)).not.toContain('native-only context sentinel')
    })
  })
})
