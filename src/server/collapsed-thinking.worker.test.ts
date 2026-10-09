import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import type { NativeFixture } from './fixtures/native-session'
import worker from '../server'

it('projects actual provider thinking through hosted native persistence, socket, history and reopened harness without extra execution', async () => {
  const id = crypto.randomUUID(), secret = 'fixture-thinking-secret'
  const localEnv = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: secret, PLATFORM: { fetch: async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/internal/chat-model/')) return Response.json({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'fixture-thinking-key', thinkingLevel: 'high', maxOutputTokens: 64 })
    if (url.includes('/internal/chat-session/')) return Response.json({ active: true })
    if (url.includes('/internal/chat-search/')) return Response.json({ enabled: false })
    throw new Error('Unexpected test-owned Platform request')
  } } } as Env
  const registry = env.PiRegistry.getByName(id) as DurableObjectStub<PiRegistry>
  const created = await registry.ensureDefaultSession()
  const stub = env.PiSession.getByName(`${id}:${created.id}`) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, instance => {
    Reflect.set(instance, 'env', localEnv); Reflect.set(instance, 'name', `${id}:${created.id}`)
    vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
  })
  const blocks = [{ type: 'thinking', thinking: 'first thought' }, { type: 'text', text: 'answer one' }, { type: 'thinking', thinking: 'second thought' }, { type: 'text', text: 'answer two' }]
  const events = [
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'text_delta', text: block.text } },
      ...(block.type === 'thinking' ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'private-fixture-signature' } }] : []),
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
  ]
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  let socket: WebSocket | undefined, client: Awaited<ReturnType<typeof openChat>> | undefined, view: ChatView | undefined
  const connect = async () => {
    const result = await worker.fetch(new Request('https://thinking.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://thinking.fixture', 'x-lamplit-instance': id, 'x-lamplit-internal-secret': secret, 'x-lamplit-session-hash': 'a'.repeat(64) } }), localEnv)
    expect(result.status).toBe(101); socket = result.webSocket!; socket.accept()
    client = await openChat(socket, next => { view = next }, () => {})
  }
  try {
    const refusal = await worker.fetch(new Request('https://thinking.fixture/api/chat/socket', { headers: { upgrade: 'websocket' } }), localEnv)
    expect(refusal.status).toBe(403)
    await connect()
    await client!.submit({ operationId: crypto.randomUUID(), text: 'Fictional native thinking input' })
    await vi.waitFor(() => expect(view?.messages.some(m => m.role === 'agent')).toBe(true), { timeout: 10000 })
    const branch = await runInDurableObject(stub, instance => (instance as unknown as { getBranch(): Promise<import('../shared/pi-contract').SessionBranch> }).getBranch())
    const content = branch.entries.find(e => e.message?.role === 'assistant')!.message!.content as Array<{ type: string; text?: string; thinking?: string }>
    expect(content.map(b => b.type)).toEqual(['thinking', 'text', 'thinking', 'text'])
    const answer = view!.messages.find(m => m.role === 'agent')!
    expect(answer).toMatchObject({ text: 'answer one\nanswer two', thinking: 'first thought\nsecond thought' })
    expect(view!.messages.find(m => m.role === 'user')).not.toHaveProperty('thinking')
    expect(JSON.stringify(view)).not.toContain('private-fixture-signature')
    await client!.submit({ operationId: crypto.randomUUID(), text: 'Second native input for real history cursor' })
    await vi.waitFor(() => expect(view!.messages.filter(m => m.role === 'agent')).toHaveLength(2), { timeout: 10000 })
    expect((await client!.history(view!.messages.at(-1)!.id)).messages).toContainEqual(answer)
    const persisted = await runInDurableObject(stub, instance => (instance as unknown as { getBranch(): Promise<import('../shared/pi-contract').SessionBranch> }).getBranch())
    client!.close(); socket!.close()
    await runInDurableObject(stub, instance => (instance as unknown as NativeFixture).native.dispose())
    await connect()
    expect(view!.messages).toContainEqual(answer)
    expect((await runInDurableObject(stub, instance => (instance as unknown as { getBranch(): Promise<import('../shared/pi-contract').SessionBranch> }).getBranch())).entries).toEqual(persisted.entries)
    expect(upstream).toHaveBeenCalledTimes(2)
    const onlyEvents = events.filter(event => !('index' in event) || event.index === 0 || event.index === 2)
    upstream.mockImplementation(async () => new Response(onlyEvents.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
    await client!.submit({ operationId: crypto.randomUUID(), text: 'Thinking-only native completion' })
    await vi.waitFor(() => expect(view!.messages.filter(m => m.text === '回复失败')).toHaveLength(1), { timeout: 10000 })
    upstream.mockImplementation(async () => Response.json({ error: { message: 'Fixture failure' } }, { status: 400 }))
    await client!.submit({ operationId: crypto.randomUUID(), text: 'Actual provider error' })
    await vi.waitFor(() => expect(view!.messages.filter(m => m.text === '回复失败')).toHaveLength(2), { timeout: 10000 })
    let started = false
    upstream.mockImplementation(async (_input, init) => {
      started = true
      return new Response(new ReadableStream({ start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      } }), { headers: { 'content-type': 'text/event-stream' } })
    })
    const stopId = crypto.randomUUID()
    await client!.submit({ operationId: stopId, text: 'Stop this native reply' })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(await client!.stop(stopId)).toEqual({ stopped: true })
    await vi.waitFor(() => expect(view!.messages.some(m => m.text === '已停止回复')).toBe(true), { timeout: 10000 })
    for (const notice of view!.messages.filter(m => m.role === 'notice')) expect(notice).not.toHaveProperty('thinking')
    expect(view!.recovery).toEqual([])
  } finally { client?.close(); socket?.close(); vi.restoreAllMocks() }
})
