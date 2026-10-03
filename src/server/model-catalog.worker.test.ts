import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/pi-agent-core/harness/context'
import type { AgentLane } from '@earendil-works/pi-agent-core'
import { accountModels, modelCatalog, nativeProviders, resolveModelSelection, selectedModel, type ModelSelection } from './model-catalog'
import { nativeReply } from './fixtures/native-provider'
import worker from '../server'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'

const secret = 'catalog-test-owned-secret'
const instanceId = '11111111-1111-4111-8111-111111111111'
const headers = { 'x-lamplit-instance': instanceId, 'x-lamplit-internal-secret': secret, origin: 'https://chat.fixture' }
const selections = [
  { provider: 'deepseek', model: 'deepseek-flash' },
  { provider: 'openai', model: 'gpt-5-mini' },
  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'openrouter', model: 'openai/gpt-4o' },
]
const selection = (value = selections[0], apiKey = 'sk-test-owned-fixture-owner-key'): ModelSelection => resolveModelSelection({ ...value, apiKey, thinkingLevel: null, maxOutputTokens: null })

type Native = { getLane(): Promise<AgentLane>; extractNextMemoryBatch(): Promise<void>; scheduleMemoryExtraction(): void; schedulePendingDrain(): Promise<void>; active: boolean }

async function owner(id: string, read: () => unknown) {
  const localEnv = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: secret, PLATFORM: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(request.headers.get('x-lamplit-internal-secret')).toBe(secret)
    if (request.url.includes('/internal/chat-model/')) { expect(request.url.endsWith(id)).toBe(true); return Response.json(read()) }
    if (request.url.includes('/internal/chat-session/')) return Response.json({ active: true })
    if (request.url.includes('/internal/chat-search/')) return Response.json({ enabled: false })
    throw new Error('Unexpected test-owned Platform request')
  } } } as Env
  const registry = env.PiRegistry.getByName(id) as DurableObjectStub<PiRegistry>
  const created = await registry.ensureDefaultSession()
  const stub = env.PiSession.getByName(`${id}:${created.id}`) as DurableObjectStub<PiSession>
  await runInDurableObject(stub, instance => {
    Reflect.set(instance, 'env', localEnv)
    Reflect.set(instance, 'name', `${id}:${created.id}`)
    vi.spyOn(instance as unknown as Native, 'scheduleMemoryExtraction').mockImplementation(() => {})
    vi.spyOn(instance as unknown as Native, 'schedulePendingDrain').mockResolvedValue(undefined)
  })
  return { stub, sessionId: created.id, localEnv, native: <T>(fn: (instance: Native) => T | Promise<T>) => runInDurableObject(stub, instance => fn(instance as unknown as Native)) }
}

it('catalog uses factory metadata, guards hosted/self-host access, has no secrets/auth lookup/network and always no-store', async () => {
  const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Catalog must not call upstream'))
  const platform = vi.fn().mockRejectedValue(new Error('Catalog must not resolve credentials'))
  const hosted = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: secret, PLATFORM: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => platform(input, init) } } as Env
  try {
    for (const override of [{ 'x-lamplit-internal-secret': 'wrong' }, { 'x-lamplit-instance': 'bad' }, { origin: 'https://wrong.fixture' }]) {
      const response = await worker.fetch(new Request('https://chat.fixture/internal/model-catalog', { headers: { ...headers, ...override } }), hosted)
      expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const response = await worker.fetch(new Request('https://chat.fixture/internal/model-catalog', { headers }), hosted)
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const catalog = await response.json() as ReturnType<typeof modelCatalog>
    expect(catalog).toEqual(modelCatalog())
    expect(catalog.providers.map(p => p.id)).toEqual(['deepseek', 'openai', 'anthropic', 'google', 'openrouter'])
    for (const provider of nativeProviders()) {
      const models = catalog.providers.find(p => p.id === provider.id)!.models
      expect(models.length).toBe(provider.getModels().length)
      for (const model of provider.getModels()) expect(models.find(m => m.id === model.id)).toMatchObject({ id: model.id, baseUrl: model.baseUrl, input: model.input, maxTokens: model.maxTokens, contextWindow: model.contextWindow })
    }
    expect(JSON.stringify(catalog)).not.toContain('apiKey')
    expect((await worker.fetch(new Request('https://chat.fixture/internal/model-catalog'), env)).status).toBe(401)
    const ownerAuth = { authorization: `Basic ${btoa('owner:fixture-password-long-enough')}` }
    const own = await worker.fetch(new Request('https://chat.fixture/internal/model-catalog', { headers: ownerAuth }), env)
    expect(own.status).toBe(200); expect(own.headers.get('cache-control')).toBe('no-store')
    expect((await worker.fetch(new Request('https://chat.fixture/internal/model-catalog', { method: 'POST', headers }), hosted)).status).toBe(405)
    expect(upstream).not.toHaveBeenCalled(); expect(platform).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})

it.each(selections)('native $provider completes a real DO tool turn with its key/protocol/capacity', async value => {
  let config = selection(value)
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push({ url: request.url, headers: request.headers, body: await request.json() })
    return nativeReply(config.provider, 'Native fixture reply', requests.length === 1)
  })
  try {
    const account = await owner(crypto.randomUUID(), () => config)
    await account.native(async n => {
      const lane = await n.getLane()
      expect(await lane.getModel(context)).toEqual(selectedModel(config))
      expect((await lane.prompt('Use the read tool then reply', undefined, context)).ok).toBe(true)
    })
    const branch = await runInDurableObject(account.stub, n => n.getBranch())
    expect(branch.entries, JSON.stringify(branch.entries)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ role: 'toolResult' }) })]))
    expect(branch.entries.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop', content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Native fixture reply' })]) })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      if (config.provider === 'anthropic') expect(request.headers.get('x-api-key')).toBe(config.apiKey)
      else if (config.provider === 'google') expect(request.headers.get('x-goog-api-key') ?? new URL(request.url).searchParams.get('key')).toBe(config.apiKey)
      else expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`)
      const serialized = JSON.stringify(request.body)
      expect(serialized).toContain('read')
      expect(request.url).toContain(new URL(selectedModel(config).baseUrl).hostname)
    }
    const nativeLimit = selectedModel(config).maxTokens
    const defaultBody = requests[0].body
    if (config.provider === 'openai') expect(defaultBody.max_output_tokens).toBe(nativeLimit)
    else if (config.provider === 'anthropic') expect(defaultBody.max_tokens).toBe(nativeLimit)
    else if (config.provider === 'google') expect(defaultBody).toMatchObject({ generationConfig: { maxOutputTokens: nativeLimit } })
    else expect(defaultBody[config.provider === 'deepseek' ? 'max_tokens' : 'max_completion_tokens']).toBe(nativeLimit)
    config = { ...config, thinkingLevel: selectedModel(config).reasoning ? 'low' : 'off', maxOutputTokens: 2500 }
    await account.native(async n => { expect((await (await n.getLane()).prompt('Advanced fixture reply', undefined, context)).ok).toBe(true) })
    const advanced = requests[2].body
    if (config.provider === 'openai') expect(advanced).toMatchObject({ max_output_tokens: 2500, reasoning: { effort: 'low' } })
    else if (config.provider === 'anthropic') expect(advanced).toMatchObject({ max_tokens: 4548, thinking: { type: 'enabled', budget_tokens: 2048 } })
    else if (config.provider === 'google') expect(advanced).toMatchObject({ generationConfig: { maxOutputTokens: 2500, thinkingConfig: { thinkingBudget: 2048 } } })
    else expect(advanced).toMatchObject(config.provider === 'deepseek' ? { max_tokens: 2500 } : { max_completion_tokens: 2500 })
  } finally { vi.restoreAllMocks() }
})

it('native credential stores are provider scoped and never use ambient environment credentials', async () => {
  const a = selection(selections[0], 'account-a-key')
  const b = selection(selections[0], 'account-b-key')
  const first = await accountModels(a), second = await accountModels(b)
  expect((await first.getAuth(a.provider))?.auth.apiKey).toBe(a.apiKey)
  expect((await second.getAuth(b.provider))?.auth.apiKey).toBe(b.apiKey)
  first.setProvider(nativeProviders().find(p => p.id === 'openai')!)
  expect(await first.getAuth('openai')).toBeUndefined()
})

it('rejects malformed selections before any upstream request', async () => {
  const upstream = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden upstream'))
  const valid = selection()
  try {
    for (const invalid of [null, { ...valid, provider: 'custom' }, { ...valid, model: 'not-a-model' }, { ...valid, apiKey: '' }, { ...valid, thinkingLevel: 'invented' }, { ...valid, maxOutputTokens: 0 }, { ...valid, maxOutputTokens: 1.5 }, { ...valid, maxOutputTokens: selectedModel(valid).maxTokens + 1 }]) {
      const account = await owner(crypto.randomUUID(), () => invalid)
      await expect(runInDurableObject(account.stub, instance => instance.prompt({ send: () => true, end: () => true }, { operationId: crypto.randomUUID(), prompt: 'Invalid fixture' }))).rejects.toThrow()
    }
    expect(upstream).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})

it('switches A/B/A with native options, keeps the in-flight harness and isolates another owner on the shared socket', async () => {
  const a = { ...selection(selections[0], 'owner-a-deepseek'), thinkingLevel: 'high' as const, maxOutputTokens: 2345 }
  const b = { ...selection(selections[4], 'owner-a-openrouter'), maxOutputTokens: 1234 }
  let current = a as ModelSelection
  const other = selection(selections[0], 'owner-b-deepseek')
  const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
  let release: (() => void) | undefined
  let hold = false
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push({ authorization: request.headers.get('authorization'), body: await request.json() })
    if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve }) }
    return nativeReply(request.url.includes('deepseek') ? 'deepseek' : 'openrouter')
  })
  const sockets: WebSocket[] = []
  const clients: Awaited<ReturnType<typeof openChat>>[] = []
  try {
    const first = await owner(instanceId, () => current)
    const second = await owner(crypto.randomUUID(), () => other)
    const open = async (account: typeof first, id: string) => {
      const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { ...headers, 'x-lamplit-instance': id, 'x-lamplit-session-hash': 'a'.repeat(64), upgrade: 'websocket' } }), account.localEnv)
      expect(response.status).toBe(101)
      const socket = response.webSocket!; socket.accept(); sockets.push(socket)
      let view: ChatView | undefined
      const client = await openChat(socket, value => { view = value }, () => {})
      clients.push(client)
      return { client, view: () => view }
    }
    const chat = await open(first, instanceId)
    expect(chat.view()?.contextUsage.capacity).toBe(selectedModel(a).contextWindow)
    expect(Boolean(chat.view()?.capabilities.images)).toBe(selectedModel(a).input.includes('image'))
    hold = true
    const input = { operationId: crypto.randomUUID(), text: 'Held native reply' }
    await chat.client.submit(input)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    current = b
    await first.native(async n => {
      expect(n.active).toBe(true)
      expect(await (await n.getLane()).getModel(context)).toEqual(selectedModel(a))
    })
    await first.native(() => release!())
    await vi.waitFor(() => expect(chat.view()?.activeTurnId).toBeNull(), { timeout: 10000 })
    const submit = async (client: typeof chat.client, account: typeof first, text: string) => {
      const operationId = crypto.randomUUID()
      await client.submit({ operationId, text })
      await vi.waitFor(async () => {
        expect(await account.native(n => n.active)).toBe(false)
        expect((await client.lookup(operationId)).state).toBe('consumed')
        const entries = (await runInDurableObject(account.stub, n => n.getBranch())).entries
        expect(entries.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
      })
    }
    await submit(chat.client, first, 'Provider B fixture')
    expect(chat.view()?.contextUsage.capacity).toBe(selectedModel(b).contextWindow)
    current = a
    await submit(chat.client, first, 'Provider A again')
    // Direct native execution uses the same account resolver, without browser auth mocking.
    await second.native(async n => { expect((await (await n.getLane()).prompt('Independent owner', undefined, context)).ok).toBe(true) })
    expect(requests.map(r => r.authorization)).toEqual(['Bearer owner-a-deepseek', 'Bearer owner-a-openrouter', 'Bearer owner-a-deepseek', 'Bearer owner-b-deepseek'])
    expect(requests[0].body).toMatchObject({ model: a.model, max_tokens: 2345, thinking: { type: 'enabled' } })
    expect(requests[1].body).toMatchObject({ model: b.model, max_completion_tokens: 1234 })
    expect(requests[2].body).toMatchObject({ model: a.model, max_tokens: 2345, thinking: { type: 'enabled' } })
    expect(requests[3].body.max_tokens).toBe(selectedModel(other).maxTokens)
    expect(requests[3].body).not.toHaveProperty('reasoning_effort')
    expect(chat.view()?.messages.some(message => message.text.includes('Private fixture reasoning'))).toBe(false)
  } finally { release?.(); clients.forEach(c => c.close()); sockets.forEach(s => s.close()); vi.restoreAllMocks() }
})

it('uses SDK image-history projection when moving to text-only and rejects new image input without changing history', async () => {
  let config = selection(selections[4])
  const requests: Record<string, unknown>[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(await request.json())
    return nativeReply(config.provider)
  })
  try {
    const account = await owner(crypto.randomUUID(), () => config)
    await account.native(async n => {
      const lane = await n.getLane()
      await lane.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Historic photo' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], timestamp: Date.now() }, context)
    })
    const before = (await runInDurableObject(account.stub, n => n.getBranch())).entries
    config = selection({ provider: 'openrouter', model: 'amazon/nova-micro-v1' })
    await account.native(async n => { expect((await (await n.getLane()).prompt('Continue after switch', undefined, context)).ok).toBe(true) })
    expect(JSON.stringify(requests[0])).toContain('(image omitted: model does not support images)')
    expect(JSON.stringify(requests[0])).not.toContain('iVBORw0KGgo=')
    const after = (await runInDurableObject(account.stub, n => n.getBranch())).entries
    expect(after.slice(0, before.length)).toEqual(before)
    await expect(runInDurableObject(account.stub, n => n.prompt({ send: () => true, end: () => true }, { operationId: crypto.randomUUID(), prompt: 'New photo', photoIds: [crypto.randomUUID()] }))).rejects.toThrow('does not support images')
    expect(requests).toHaveLength(1)
  } finally { vi.restoreAllMocks() }
})

it('memory extraction and companion compaction use the same native selected provider and options', async () => {
  let config = { ...selection(selections[0], 'maintenance-deepseek-key'), maxOutputTokens: 2500, thinkingLevel: 'low' as const } as ModelSelection
  const requests: Array<{ key: string | null; body: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init), body = await request.json() as Record<string, unknown>
    requests.push({ key: request.headers.get('authorization'), body })
    return JSON.stringify(body).includes('record_memory_changes') ? nativeReply(config.provider, '', { name: 'record_memory_changes', arguments: { operations: [] } }) : nativeReply(config.provider, 'Native continuity checkpoint')
  })
  try {
    const account = await owner(crypto.randomUUID(), () => config)
    await account.native(async n => {
      const lane = await n.getLane()
      for (let index = 0; index < 4; index++) await lane.appendMessage({ role: 'user', content: `Synthetic maintenance history ${index} ` + 'a'.repeat(12000), timestamp: Date.now() }, context)
      await n.extractNextMemoryBatch()
    })
    expect(requests[0].key).toBe('Bearer maintenance-deepseek-key')
    expect(requests[0].body).toMatchObject({ model: config.model, max_tokens: 2500 })
    config = { ...selection(selections[4], 'maintenance-openrouter-key'), maxOutputTokens: 1800 }
    await account.native(async n => { const result = await (await n.getLane()).compact(undefined, context); expect(result.ok).toBe(true); if (result.ok) expect(result.value.compaction.status).toBe('completed') })
    expect(requests.at(-1)?.key).toBe('Bearer maintenance-openrouter-key')
    expect(requests.at(-1)?.body).toMatchObject({ model: config.model, max_completion_tokens: 1800 })
    expect(JSON.stringify(requests.at(-1)?.body)).toContain('continuity checkpoint')
  } finally { vi.restoreAllMocks() }
})

it('summarized navigation refreshes an idle saved selection and rejects invalid settings before upstream', async () => {
  let config: unknown = selection(selections[0], 'navigation-a-key')
  const requests: Array<{ key: string | null; body: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push({ key: request.headers.get('authorization'), body: await request.json() })
    return nativeReply(request.url.includes('deepseek') ? 'deepseek' : 'openai', 'Native navigation summary')
  })
  try {
    const account = await owner(crypto.randomUUID(), () => config)
    const target = await account.native(async n => {
      const lane = await n.getLane()
      const id = await lane.appendMessage({ role: 'user', content: 'Navigation anchor', timestamp: Date.now() }, context)
      await lane.appendMessage({ role: 'user', content: 'Synthetic abandoned branch history', timestamp: Date.now() }, context)
      return id
    })
    config = { ...selection(selections[1], 'sk-navigation-b-key'), thinkingLevel: 'low', maxOutputTokens: 2345 }
    await runInDurableObject(account.stub, n => n.navigateTree(target, { summarize: true }))
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ key: 'Bearer sk-navigation-b-key', body: { model: 'gpt-5-mini', max_output_tokens: 2345 } })
    expect(await account.native(async n => (await n.getLane()).getThinkingLevel(context))).toBe('low')
    config = { ...config as ModelSelection, model: 'invalid-navigation-model' }
    await expect(runInDurableObject(account.stub, n => n.navigateTree(target, { summarize: true }))).rejects.toThrow('Unsupported provider or model')
    expect(requests).toHaveLength(1)
    expect(await account.native(n => n.active)).toBe(false)
  } finally { vi.restoreAllMocks() }
})
