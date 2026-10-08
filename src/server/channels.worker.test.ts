import { env } from 'cloudflare:workers'
import { runInDurableObject, evictDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker from '../server'
import { PiSession } from './pi-session'
import { ChannelStorage } from './channel-storage'
import { PiSessionStorage } from './pi-session-storage'
import { parseChannelEvent } from './channel-events'
import { channelConfig } from './channel-config'
import { branchItems, projectPromptBranch, beginOptimisticPrompt } from '../../frontend/src/lib/companion/pi-projection'

const config = { mcpUrl: 'https://mcp.example.invalid/mcp', mcpToken: 'synthetic-mcp', webhookToken: 'synthetic-webhook-token', aliases: ['Companion'] }
const keet = (text = 'hello', kind = 'dm', extra: Record<string, unknown> = {}) => ({ type: 'message', eventId: crypto.randomUUID(), sequence: 42, messageId: { deviceId: 'device', seq: 7 }, timestamp: 1790000000000, destination: { groupName: 'Room', kind }, senderLabel: 'Other', text, addressing: { mentionsIdentity: false }, ...extra })
const matrix = (body = 'Companion hello', extra: Record<string, unknown> = {}) => ({ type: 'message', room_id: '!room:test', event_id: '$event', sender_id: '@other:test', sender_display_name: '', body, mentions: [], timestamp: 1790000000001, truncated: false, ...extra })
async function fixture() {
  const id = crypto.randomUUID(), stub = env.PiSession.getByName(id) as DurableObjectStub<PiSession>
  await stub.initialize({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lineage: { type: 'new' } })
  const testEnv = { ...env, CHAT_INTEGRATIONS: JSON.stringify({ keet: config }), COMPANION_SESSION_ID: id } as unknown as Env
  await runInDurableObject(stub, async (_agent, ctx) => {
    // Test-owned DO env configured through real ingress before durable admission.
    Object.assign((_agent as unknown as { env: Env }).env, { CHAT_INTEGRATIONS: testEnv.CHAT_INTEGRATIONS })
    const session = _agent as unknown as { active: boolean; schedulePendingDrain(): Promise<void> }
    session.active = true
    session.schedulePendingDrain = async () => {}
    expect(new PiSessionStorage(ctx.storage).isInitialized()).toBe(true)
  })
  return { id, stub, post: (value: unknown, token = config.webhookToken) => worker.fetch(new Request('https://chat.test/api/keet/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: typeof value === 'string' ? value : JSON.stringify(value) }), testEnv) }
}

describe('channel Worker admission into real durable sessions', () => {
  it('loads both Hosted channels with maximum legal JSON-escaped MCP tokens', async () => {
    const channels = {
      keet: { ...config, mcpToken: '\\'.repeat(16384) },
      matrix: { ...config, mcpToken: '\\'.repeat(16384), webhookToken: 'synthetic-matrix-receiver' },
    }
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://platform.test/internal/chat-integrations/synthetic-instance')
      expect(request.headers.get('x-lamplit-internal-secret')).toBe('synthetic-internal')
      return Response.json(channels)
    })
    const selected = await channelConfig({ ...env, PLATFORM_ORIGIN: 'https://platform.test', CHAT_INTERNAL_SECRET: 'synthetic-internal', PLATFORM: { fetch } } as unknown as Env, 'synthetic-instance')
    expect(selected).toEqual(channels)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('rejects transport-unsafe tokens with sanitized503 before body or DO access', async () => {
    for (const [field, value] of [['webhookToken', 'synthetic-trailing '], ['mcpToken', 'token\ncontrol'], ['mcpToken', '秘密token']] as const) {
      const request = new Request('https://chat.test/api/keet/events', { method: 'POST', headers: { authorization: 'Bearer synthetic-webhook-token' }, body: 'not parsed' })
      const reader = vi.spyOn(request.body!, 'getReader')
      const response = await worker.fetch(request, { ...env, CHAT_INTEGRATIONS: JSON.stringify({ keet: { ...config, [field]: value } }) })
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain(value)
      expect(reader).not.toHaveBeenCalled()
    }
  })
  it('authenticates before consuming bodies, admits current sequence without initial-one restriction and deduplicates/conflicts', async () => {
    const f = await fixture(), event = keet()
    expect((await f.post(event, 'wrong')).status).toBe(401)
    expect((await f.post(event)).status).toBe(202)
    expect((await f.post(event)).status).toBe(202)
    expect((await f.post({ ...event, text: 'changed' })).status).toBe(409)
    await runInDurableObject(f.stub, async (_, ctx) => expect(new ChannelStorage(ctx.storage).pendingCount()).toBe(1))
    expect((await f.post(keet('hello', 'group', { trigger: 'mention' }))).status).toBe(400)
    expect((await f.post('x'.repeat(112 * 1024 + 1))).status).toBe(413)
  })
  it('buffers ordinary Group, prioritizes addressing, suppresses reaction receipts only on turns and preserves immutable authored source', async () => {
    const f = await fixture()
    const reaction = { targetMessageId: { deviceId: 'self', seq: 2 }, targetText: 'prior', emoji: '👍', externalCount: 1 }
    expect((await f.post(keet('ordinary', 'group', { reactionContext: [reaction] }))).status).toBe(202)
    expect((await f.post(keet('caption', 'group', { addressing: { mentionsIdentity: true }, reactionContext: [reaction] }))).status).toBe(202)
    expect((await f.post(keet('reply', 'group', { replyTo: { deviceId: 'self', seq: 2 }, addressing: { mentionsIdentity: false, replyToIdentity: true }, reactionContext: [reaction] }))).status).toBe(202)
    expect((await f.post(keet('news', 'broadcast'))).status).toBe(202)
    expect((await f.post(keet('', 'dm', { images: [{ status: 'unavailable', mediaType: 'image/png' }] }))).status).toBe(202)
    await runInDurableObject(f.stub, async (_, ctx) => {
      const queue = new ChannelStorage(ctx.storage)
      expect(queue.pendingCount()).toBe(2)
      const first = queue.next()!
      const body = JSON.parse(first.prompt.split('\n')[1])
      expect(body.recentContext).toEqual([{ sender: 'Other', text: 'ordinary' }])
      expect(body.reactionContext).toEqual([reaction])
      queue.correlate(first.operation_id, 'entry')
      expect(queue.source('entry')).toMatchObject({ text: 'caption', timestamp: 1790000000000, channel: 'keet' })
      queue.complete(first.operation_id)
      expect(JSON.parse(queue.next()!.prompt.split('\n')[1]).reactionContext).toEqual([])
    })
  })
  it('rolls back receipts and context at shared64 capacity and reloads ordered durable queue', async () => {
    const f = await fixture()
    await runInDurableObject(f.stub, async (_, ctx) => {
      let queue = new ChannelStorage(ctx.storage)
      for (let n = 0; n < 64; n++) {
        const event = n % 2 ? parseChannelEvent('matrix', matrix('Companion', { event_id: `$${n}`, timestamp: 10 - n }), config, '@self:test') : parseChannelEvent('keet', keet(), config)
        queue.admit(event, `hash${n}`)
      }
      const overflow = parseChannelEvent('matrix', matrix('Companion', { event_id: '$overflow' }), config, '@self:test')
      expect(() => queue.admit(overflow, 'overflow')).toThrow('Channel unavailable')
      expect(ctx.storage.sql.exec("SELECT * FROM channel_receipts WHERE event_key=?", overflow.key).toArray()).toHaveLength(0)
      const first = queue.next()!
      queue = new ChannelStorage(ctx.storage)
      expect(queue.next()).toEqual(first)
      queue.complete(first.operation_id)
      expect(queue.admit(overflow, 'overflow')).toBe(true)
      expect(queue.pendingCount()).toBe(64)
    })
  })
  it('matches current Matrix blank and UTF16 envelopes and never auto-triggers DM/reply/display labels', () => {
    expect(parseChannelEvent('matrix', matrix(''), config, '@self:test')).toMatchObject({ trigger: false, buffer: false })
    expect(parseChannelEvent('matrix', matrix('🙂'.repeat(8000)), config, '@self:test').trigger).toBe(false)
    expect(() => parseChannelEvent('matrix', matrix('🙂'.repeat(8001)), config, '@self:test')).toThrow()
    expect(parseChannelEvent('matrix', matrix('reply', { reply_to_event_id: '$self', sender_display_name: 'Companion' }), config, '@self:test').trigger).toBe(false)
    expect(parseChannelEvent('matrix', matrix('hello', { mentions: ['@self:test'] }), config, '@self:test').trigger).toBe(true)
    expect(parseChannelEvent('matrix', matrix('Companion', { sender_id: '@self:test' }), config, '@self:test').trigger).toBe(false)
    expect(parseChannelEvent('matrix', matrix('companion'), config, '@self:test').trigger).toBe(false)
  })
  it('executes queued original sources through native Pi after durable object eviction', async () => {
    const f = await fixture(), requests: Array<{ messages: unknown[] }> = []
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url !== 'https://example.invalid/v1/chat/completions') throw new Error('Non-fixture network refused')
      requests.push(await request.json() as { messages: unknown[] })
      return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const memory = vi.spyOn(PiSession.prototype as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
    const scheduled = vi.spyOn(PiSession.prototype as unknown as { schedulePendingDrain(): Promise<void> }, 'schedulePendingDrain').mockResolvedValue()
    try {
      const first = keet('first external'), second = keet('second external', 'dm', { timestamp: 1 })
      expect((await f.post(first)).status).toBe(202)
      expect((await f.post(second)).status).toBe(202)
      expect(requests).toHaveLength(0)
      await evictDurableObject(f.stub)
      await f.stub.drainPendingWork()
      await f.stub.drainPendingWork()
      const branch = await (f.stub as unknown as { getBranch(): Promise<import('../shared/pi-contract').SessionBranch> }).getBranch()
      expect(branch.entries.filter(entry => entry.source).map(entry => entry.source?.text)).toEqual(['first external', 'second external'])
      expect(branch.entries.find(entry => entry.source?.text === 'second external')?.source?.timestamp).toBe(1)
      expect(requests).toHaveLength(2)
      expect((await f.post(first)).status).toBe(202)
      await f.stub.drainPendingWork()
      expect(requests).toHaveLength(2)
    } finally { network.mockRestore(); memory.mockRestore(); scheduled.mockRestore() }
  })
  it('projects original incoming source without hiding it behind optimistic web/photo work', () => {
    const source = parseChannelEvent('matrix', matrix(), config, '@self:test').source
    const entries = [{ id: 'channel-entry', seq: 2, parentId: null, type: 'message', timestamp: new Date().toISOString(), source, message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'private wrapper' }] } }]
    expect(branchItems(entries)[0]).toMatchObject({ side: 'incoming', text: source.text, source, time: source.timestamp })
    expect(projectPromptBranch(entries, beginOptimisticPrompt(crypto.randomUUID(), 'web draft'), 1)).toHaveLength(1)
  })
})
