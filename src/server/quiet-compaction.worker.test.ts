import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { appendNative, type NativeFixture } from './fixtures/native-session'
import type { PiSessionStorage } from './pi-session-storage'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import worker from '../server'

type Native = NativeFixture & { sessionStorage: PiSessionStorage; chatObservation(): Promise<Pick<ChatView, 'contextUsage' | 'compaction'>>; scheduleMemoryExtraction(): void; schedulePendingDrain(): Promise<void>; ctx: DurableObjectState }
const assistant = (tokens: number) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'seed reply' }], api: 'openai-completions' as const, provider: 'configured-provider', model: 'fixture-model', usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp: Date.now() })

it('runs native manual/automatic compaction, refuses active/queued work, preserves failures and fresh completion usage without replay', async () => {
  let release: (() => void) | undefined
  let fail = false, calls = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls++
    const body = new ReadableStream({ start(controller) {
      release = () => {
        if (fail) { controller.error(new Error('test-owned provider failure')); return }
        controller.enqueue(new TextEncoder().encode('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Native continuity checkpoint"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n'))
        controller.close()
      }
    } })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.ensureDefaultSession()
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  const native = <T>(fn: (n: Native) => Promise<T> | T) => runInDurableObject(stub, instance => fn(instance as unknown as Native))
  await native(async n => {
    vi.spyOn(n, 'scheduleMemoryExtraction').mockImplementation(() => {})
    vi.spyOn(n, 'schedulePendingDrain').mockResolvedValue(undefined)
    await (n as unknown as PiSession).updateCompactionSettings({ enabled: true, reserveTokens: 1000, keepRecentTokens: 100 })
    const lane = await n.getLane()
    await appendNative(lane, { role: 'user', content: 'fixture conversation ' + 'x'.repeat(4000), timestamp: Date.now() }, context)
    await appendNative(lane, assistant(80000), context)
    await appendNative(lane, { role: 'user', content: 'retained fixture ' + 'x'.repeat(4000), timestamp: Date.now() }, context)
    await appendNative(lane, assistant(80000), context)
  })
  const open = async () => {
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), env)
    const ws = response.webSocket!; ws.accept(); return ws
  }
  let ws = await open(), view: ChatView | undefined
  let client = await openChat(ws, value => { view = value }, () => {})
  try {
    expect(view?.contextUsage).toEqual({ tokens: 80000, capacity: 128000 })
    await expect(client.submit({ operationId: crypto.randomUUID(), text: '/compact' })).rejects.toThrow()
    expect((await native(n => n.sessionStorage.chatRecords())).size).toBe(0)
    await expect(client.compact({ sessionId: 'wrong-session' })).rejects.toThrow()
    expect(await client.compact({ sessionId: created.id })).toEqual({ sessionId: created.id, accepted: true })
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 10000 })
    await vi.waitFor(() => expect(view?.compaction?.status).toBe('running'), { timeout: 10000 })
    expect(await client.compact({ sessionId: created.id })).toEqual({ sessionId: created.id, accepted: false })
    await native(() => { const finish = release; release = undefined; finish!() })
    await vi.waitFor(() => expect(view?.compaction?.status).toBe('complete'), { timeout: 10000 })
    expect(view?.contextUsage).toEqual({ tokens: 0, capacity: 128000 })
    const branch = await native(n => (n as unknown as PiSession).getBranch().then(page => page.entries))
    expect(branch.filter(e => e.type === 'compaction')).toHaveLength(1)
    expect(view?.messages.some(m => m.text.includes('Native continuity checkpoint'))).toBe(false)
    client.close(); ws.close(); ws = await open(); client = await openChat(ws, value => { view = value }, () => {})
    expect(calls).toBe(1)
    expect(view?.contextUsage.tokens).toBe(0)
    // Read the first complete snapshot with fresh usage: no later refresh is needed.
    await native(async n => { await appendNative(await n.getLane(), { role: 'user', content: 'recent fixture ' + 'x'.repeat(4000), timestamp: Date.now() }, context); await appendNative(await n.getLane(), assistant(12000), context); expect(await n.chatObservation()).toMatchObject({ compaction: { status: 'complete' }, contextUsage: { tokens: 12000 } }) })
    await vi.waitFor(async () => expect(await native(n => (n as unknown as { active: boolean }).active)).toBe(false), { timeout: 10000 })
    fail = true
    expect((await client.compact({ sessionId: created.id })).accepted).toBe(true)
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 10000 }); await native(() => { const finish = release; release = undefined; finish!() })
    await vi.waitFor(() => expect(view?.compaction?.status).toBe('failed'), { timeout: 10000 })
    expect((await native(n => (n as unknown as PiSession).getBranch().then(page => page.entries))).filter(e => e.type === 'compaction')).toHaveLength(1)
    expect(view?.contextUsage.tokens).toBe(12000)
    // Automatic compaction uses the real threshold path and native start/end events.
    fail = false
    const operationId = crypto.randomUUID()
    await native(async n => { await appendNative(await n.getLane(), { role: 'user', content: 'automatic fixture ' + 'x'.repeat(4000), timestamp: Date.now() }, context); await appendNative(await n.getLane(), assistant(127000), context) })
    expect(await client.submit({ operationId, text: 'trigger automatic threshold' })).toMatchObject({ state: 'submitted' })
    await vi.waitFor(() => expect(calls).toBe(3), { timeout: 10000 }); await vi.waitFor(() => expect(view?.compaction?.status).toBe('running'), { timeout: 10000 }); await native(() => { const finish = release; release = undefined; finish!() })
    await vi.waitFor(() => expect(calls).toBe(4), { timeout: 10000 }); await native(() => { const finish = release; release = undefined; finish!() })
    await vi.waitFor(() => expect(view?.compaction?.status).toBe('complete'), { timeout: 10000 })
    expect((await native(n => (n as unknown as PiSession).getBranch().then(page => page.entries))).filter(e => e.type === 'compaction')).toHaveLength(2)
    // A later fast native operation can complete without a socket poll ever
    // seeing it running. Its terminal record must retire the prior failure.
    await native(async n => {
      await appendNative(await n.getLane(), {role:'user',content:'fresh compactable context '+ 'x'.repeat(4000),timestamp:Date.now()},context)
      await appendNative(await n.getLane(), assistant(12000), context)
      const task = await (await n.getLane()).compact(undefined, context)
      const wait = (await n.getHarness()).waitForTask(task, context)
      while (!release) await new Promise(resolve=>setTimeout(resolve,5))
      const finish = release; release = undefined; finish()
      await wait
      expect(await n.chatObservation()).toMatchObject({compaction:{id:String(task),status:'complete'},contextUsage:{tokens:0}})
    })
  } finally { await native(() => release?.()); client.close(); ws.close(); vi.restoreAllMocks() }
})

it('revalidates the captured hosted caller, connection loss and session generation after async preparation before native admission', async () => {
  const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
  const created = await registry.ensureDefaultSession()
  const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
  type Guarded = Native & { compactChat(input: { sessionId: string }): Promise<{ accepted: boolean }>; env: Env; verifyConnection(connection: unknown): Promise<void>; chatConnections: Map<string, unknown> }
  const native = <T>(fn: (n: Guarded) => Promise<T> | T) => runInDurableObject(stub, instance => fn(instance as unknown as Guarded))
  await native(async n => {
    await appendNative(await n.getLane(), { role: 'user', content: 'native owned test context', timestamp: Date.now() }, context)
    vi.spyOn(n, 'scheduleMemoryExtraction').mockImplementation(() => {})
  })
  const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), env)
  const ws = response.webSocket!; ws.accept()
  const client = await openChat(ws, () => {}, () => {})
  let release: (() => void) | undefined, prepared = false, revoked = false, admissions = 0
  try {
    await native(async n => {
      const harness = await n.getHarness()
      const lane = await n.getLane()
      vi.spyOn(lane, 'compact').mockImplementation(async () => { admissions++; throw new Error('Admission should not occur') })
      const original = n.compactChat.bind(n)
      let preparing = false
      vi.spyOn(n, 'compactChat').mockImplementation(input => { preparing = true; return original(input) })
      vi.spyOn(n, 'getHarness').mockImplementation(async () => {
        if (preparing) {
          preparing = false; prepared = true
          await new Promise<void>(resolve => { release = resolve })
        }
        return harness
      })
      vi.spyOn(n, 'verifyConnection').mockImplementation(async () => { if (revoked) throw new Error('Revoked test-owned connection') })
    })
    const refused = client.compact({ sessionId: created.id })
    const outcome = refused.then(value => value, error => error)
    await vi.waitFor(() => expect(prepared).toBe(true))
    revoked = true
    await native(n => { n.env.HOSTED_MODE = 'true'; release!() })
    expect(await outcome).toBeInstanceOf(Error)
    expect(admissions).toBe(0)
  } finally {
    await native(n => { n.env.HOSTED_MODE = 'false'; release?.() })
    client.close(); ws.close(); vi.restoreAllMocks()
  }
})
