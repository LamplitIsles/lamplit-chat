import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import type { PiRegistry } from './pi-registry'
import type { PiSession } from './pi-session'
import worker from '../server'

it.each([
  { content: undefined, finish: 'stop', failed: true },
  { content: '   ', finish: 'stop', failed: true },
  { content: 'Fixture final answer', finish: 'stop', failed: false },
])('handles reasoning with final content $content and finish $finish', async ({ content, finish, failed }) => {
  const original = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.startsWith('https://example.invalid/')) return original(input, init)
    const chunks = [
      { id: 'empty-reply', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Fixture private reasoning', ...(content === undefined ? {} : { content }) }, finish_reason: null }] },
      { id: 'empty-reply', choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  let client: Awaited<ReturnType<typeof openChat>> | undefined
  let socket: WebSocket | undefined
  try {
    const registry = env.PiRegistry.getByName('singleton') as DurableObjectStub<PiRegistry>
    const created = await registry.createSession({ name: 'Empty reply fixture' })
    const stub = env.PiSession.getByName(created.id) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, instance => { vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {}) })
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { upgrade: 'websocket', origin: 'https://chat.fixture', authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` } }), { ...env, COMPANION_SESSION_ID: created.id } as Env)
    expect(response.status).toBe(101)
    socket = response.webSocket!; socket.accept()
    let view: ChatView | undefined
    client = await openChat(socket, value => { view = value }, () => {})
    const input = { operationId: crypto.randomUUID(), text: 'Reply to this fixture message' }
    await client.submit(input)
    await vi.waitFor(async () => {
      const branch = await runInDurableObject(stub, instance => instance.getBranch())
      expect(branch.entries.some(entry => entry.message?.role === 'assistant' && 'stopReason' in entry.message && entry.message.stopReason === finish)).toBe(true)
      expect(view?.activeTurnId).toBeNull()
      expect(view?.messages.some(message => message.role === 'user' && message.text === input.text)).toBe(true)
    }, { timeout: 10000 })
    expect((await client.lookup(input.operationId)).state).toBe('consumed')
    expect(view?.messages.some(message => message.role === 'user' && message.text === input.text)).toBe(true)
    expect(view?.messages.some(message => message.role === 'notice' && message.text === '回复失败')).toBe(failed)
    if (!failed) expect(view?.messages.some(message => message.role === 'agent' && message.text === content)).toBe(true)
    expect(view?.messages.some(message => message.text.includes('Fixture private reasoning'))).toBe(false)
  } finally { client?.close(); socket?.close(); vi.restoreAllMocks() }
})
