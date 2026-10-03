import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import worker from '../server'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'

it('serves the shared Chord protocol from the real Pi DO, admits once and recovers on a new socket', async () => {
  let failProvider = false
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('https://openrouter.ai/')) return original(input, init)
    if (failProvider) return new Response(JSON.stringify({ error: { message: 'Fixture invalid request', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    return new Response('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Complete Pi reply"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  let socket: WebSocket | undefined
  try {
    const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
    const created = await registry.ensureDefaultSession()
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, instance => { vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {}) })
    const open = async () => {
      const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), env)
      expect(response.status).toBe(101)
      const ws = response.webSocket!; ws.accept(); return ws
    }
    socket = await open()
    let serial = 0
    const frames: Array<Record<string, unknown>> = []
    socket.addEventListener('message', event => { frames.push(JSON.parse(String(event.data))) })
    const call = async (member: string, args: unknown[], serviceId = 'lamplit.chat.v1') => {
      const id = String(++serial)
      socket!.send(JSON.stringify({ type: 'call', version: 1, id, call: { serviceId, member, args } }))
      await vi.waitFor(() => expect(frames.some(f => f.id === id)).toBe(true), { timeout: 10000 })
      return frames.find(f => f.id === id)!
    }
    const catalogue = await call('catalogue', [], '$chord.service')
    expect(catalogue.type).toBe('result')
    const input = { operationId: crypto.randomUUID(), text: 'Pi shared protocol fixture' }
    const receipt = await call('submit', [input]); expect(receipt.type).toBe('result')
    expect(await call('submit', [input])).toMatchObject({ type: 'result' })
    await vi.waitFor(async () => expect((await runInDurableObject(stub, instance => instance.getBranch())).entries.some(e => e.message?.role === 'assistant')).toBe(true), { timeout: 10000 })
    const branch = await runInDurableObject(stub, instance => instance.getBranch())
    expect(branch.entries.filter(e => e.message?.role === 'user')).toHaveLength(1)
    expect((await call('lookup', [input.operationId])).result).toMatchObject({ state: 'consumed' })
    expect((await call('stop', ['old-turn'])).result).toEqual({ stopped: false })
    socket.close(); socket = await open(); frames.length = 0
    socket.addEventListener('message', event => { frames.push(JSON.parse(String(event.data))) })
    expect((await call('lookup', [input.operationId])).result).toMatchObject({ state: 'consumed' })
    let view: ChatView | undefined
    const client = await openChat(socket, value => { view = value }, () => {})
    try {
      await vi.waitFor(() => expect(view?.activeTurnId).toBeNull())
      expect(view?.messages.some(m => m.role === 'agent' && m.text === 'Complete Pi reply')).toBe(true)
      expect(view?.messages.some(m => m.text === '回复完成')).toBe(false)
      const turnId = crypto.randomUUID()
      await runInDurableObject(stub, async instance => {
        const lane = await (instance as unknown as { getLane(): Promise<AgentLane> }).getLane()
        const admitted = await lane.accept({ kind: 'prompt', operationId: turnId, prompt: 'stop before generation' }, BACKGROUND_CONTEXT)
        if (!admitted.ok) throw admitted.error
      })
      const queued = { operationId: crypto.randomUUID(), text: 'unconsumed additional input' }
      expect((await client.submit(queued)).state).toBe('accepted')
      expect(await client.stop(turnId)).toEqual({ stopped: true })
      expect((await client.lookup(queued.operationId)).state).toBe('unconsumed')
      await vi.waitFor(() => expect(view?.messages.some(m => m.turnId === turnId && m.role === 'notice' && m.text === '已停止回复')).toBe(true))
      expect(view?.messages.some(m => m.operationId === queued.operationId)).toBe(false)
      failProvider = true
      const failed = { operationId: crypto.randomUUID(), text: 'fixture failed reply' }
      await client.submit(failed)
      await vi.waitFor(() => expect(view?.messages.some(m => m.turnId === failed.operationId && m.role === 'notice' && m.text === '回复失败')).toBe(true), { timeout: 10000 })
    } finally { client.close() }
    const rejected = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://evil.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), env)
    expect(rejected.status).toBe(403)
  } finally { socket?.close(); vi.restoreAllMocks() }
})
