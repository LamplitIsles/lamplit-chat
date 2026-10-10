import { runNative, selectedNativeModel, appendNative, type NativeFixture } from './fixtures/native-session'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { openChat } from '@lamplit/contracts/client'
import type { ChatView } from '@lamplit/contracts'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Conversation } from '@earendil-works/pi-durable'
import { accountModels, modelCatalog, nativeProviders, resolveModelSelection, selectedModel, type ModelSelection } from './model-catalog'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
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

type Native = { getLane(): Promise<Conversation>; extractNextMemoryBatch(): Promise<void>; scheduleMemoryExtraction(): void; schedulePendingDrain(): Promise<void>; active: boolean }

async function owner(id: string, read: () => unknown, searchEnabled = () => false) {
  const localEnv = { ...env, HOSTED_MODE: 'true', CHAT_INTERNAL_SECRET: secret, PLATFORM: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(request.headers.get('x-lamplit-internal-secret')).toBe(secret)
    if (request.url.includes('/internal/chat-model/')) { expect(request.url.endsWith(id)).toBe(true); return Response.json(read()) }
    if (request.url.includes('/internal/chat-session/')) return Response.json({ active: true })
    if (request.url.includes('/internal/chat-search/')) return Response.json(searchEnabled() ? { enabled: true, provider: 'brave', apiKey: 'test-owned-search-key' } : { enabled: false })
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
    expect(catalog.providers).toHaveLength(37)
    expect(catalog.providers.map(p => p.id).slice(0, 5)).toEqual(['deepseek', 'openai', 'anthropic', 'google', 'openrouter'])
    expect(new TextEncoder().encode(JSON.stringify(catalog)).byteLength).toBeLessThan(4 * 1024 * 1024)
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
      expect(await selectedNativeModel(lane, context)).toEqual(selectedModel(config))
      expect((await runNative(n, 'Use the read tool then reply')).status).toBe('done')
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
    await account.native(async n => { expect((await runNative(n, 'Advanced fixture reply')).status).toBe('done') })
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
      await expect(runInDurableObject(account.stub, instance => runNative(instance, 'Invalid fixture'))).rejects.toThrow()
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
      expect((await (n as unknown as NativeFixture).native.pending()).length).toBeGreaterThan(0)
      expect(await selectedNativeModel((await n.getLane()), context)).toEqual(selectedModel(a))
    })
    await first.native(() => release!())
    await vi.waitFor(() => expect(chat.view()?.activeTurnId).toBeNull(), { timeout: 10000 })
    const submit = async (client: typeof chat.client, account: typeof first, text: string) => {
      const operationId = crypto.randomUUID()
      await client.submit({ operationId, text })
      await vi.waitFor(async () => {
        expect(await account.native(n => n.active)).toBe(false)
        expect((await client.lookup(operationId))?.state).toBe('submitted')
        const entries = (await runInDurableObject(account.stub, n => n.getBranch())).entries
        expect(entries.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop' })
      })
    }
    await submit(chat.client, first, 'Provider B fixture')
    expect(chat.view()?.contextUsage.capacity).toBe(selectedModel(b).contextWindow)
    current = a
    await submit(chat.client, first, 'Provider A again')
    // Direct native execution uses the same account resolver, without browser auth mocking.
    await second.native(async n => { expect((await runNative(n, 'Independent owner')).status).toBe('done') })
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
      await appendNative(lane, { role: 'user', content: [{ type: 'text', text: 'Historic photo' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], timestamp: Date.now() }, context)
    })
    const before = (await runInDurableObject(account.stub, n => n.getBranch())).entries
    config = selection({ provider: 'openrouter', model: 'amazon/nova-micro-v1' })
    await account.native(async n => { expect((await runNative(n, 'Continue after switch')).status).toBe('done') })
    expect(JSON.stringify(requests[0])).toContain('(image omitted: model does not support images)')
    expect(JSON.stringify(requests[0])).not.toContain('iVBORw0KGgo=')
    const after = (await runInDurableObject(account.stub, n => n.getBranch())).entries
    expect(after.slice(0, before.length)).toEqual(before)
    expect(await runInDurableObject(account.stub, n => n.submitChat({ operationId: crypto.randomUUID(), text: 'New photo', images: [{attachmentId:crypto.randomUUID(),name:'fixture.png',mediaType:'image/png',availability:'available'}] }))).toMatchObject({state:'failed',error:'Selected model does not support images.'})
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
      for (let index = 0; index < 4; index++) await appendNative(lane, { role: 'user', content: `Synthetic maintenance history ${index} ` + 'a'.repeat(12000), timestamp: Date.now() }, context)
      await (n as unknown as { flushOutboxToRegistry(): Promise<void> }).flushOutboxToRegistry()
      await n.extractNextMemoryBatch()
    })
    expect(requests[0].key).toBe('Bearer maintenance-deepseek-key')
    expect(requests[0].body).toMatchObject({ model: config.model, max_tokens: 2500 })
    config = { ...selection(selections[4], 'maintenance-openrouter-key'), maxOutputTokens: 1800 }
    await runInDurableObject(account.stub, instance => instance.updateCompactionSettings({enabled:true,reserveTokens:1000,keepRecentTokens:100}))
    await account.native(async n => { const task = await (await n.getLane()).compact(undefined, context); const result=await (await (n as unknown as NativeFixture).getHarness()).waitForTask(task,context); expect(result.state.outcome.status).toBe('completed') })
    expect(requests.at(-1)?.key).toBe('Bearer maintenance-openrouter-key')
    expect(requests.at(-1)?.body).toMatchObject({ model: config.model, max_completion_tokens: 1800 })
    expect(JSON.stringify(requests.at(-1)?.body)).toContain('continuity checkpoint')
  } finally { vi.restoreAllMocks() }
})



// Inventory from the installed public registry; no remote catalog or auth login.
it('every builtin is enabled or has a concrete key-only/chat exclusion', async () => {
  const excluded = ['azure', 'cloudflare-ai-gateway', 'cloudflare-workers-ai', 'openai-codex', 'typesafe']
  const enabled = nativeProviders()
  const all = builtinProviders()
  expect(all).toHaveLength(42)
  expect(all.map(p => p.id).sort()).toEqual([...enabled.map(p => p.id), ...excluded].sort())
  for (const provider of all) {
    const key = `${provider.id}-test-owned-key`
    const auth = await provider.auth.apiKey?.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, credential: { type: 'api_key', key }, signal: new AbortController().signal })
    if (provider.id.startsWith('cloudflare-') || provider.id === 'openai-codex') expect(auth).toBeUndefined()
    else expect(auth?.auth.apiKey).toBe(key)
    if (provider.id === 'typesafe') expect(provider.getModels()).toEqual([])
    else if (provider.id === 'azure') expect(provider.getModels().every(m => !m.baseUrl)).toBe(true)
    else if (!excluded.includes(provider.id)) {
      const registered = enabled.find(p => p.id === provider.id)!
      expect(registered.getModels()).toEqual(provider.getModels())
      for (const model of registered.getModels()) {
        const config = resolveModelSelection({ provider: provider.id, model: model.id, apiKey: key, thinkingLevel: null, maxOutputTokens: null })
        expect(selectedModel(config)).toEqual(model)
        for (const level of getSupportedThinkingLevels(model)) expect(resolveModelSelection({ ...config, thinkingLevel: level, maxOutputTokens: model.maxTokens }).thinkingLevel).toBe(level)
      }
      const models = await accountModels(selection({ provider: provider.id, model: provider.getModels()[0].id }, key))
      expect((await models.getAuth(provider.id))?.auth.apiKey).toBe(key)
      for (const other of enabled.filter(p => p.id !== provider.id)) {
        models.setProvider(other)
        expect(await models.getAuth(other.id)).toBeUndefined()
      }
    }
  }
})

it.each(['google-vertex', 'mistral', 'radius', 'amazon-bedrock'])('new native %s protocol completes tools, options and memory in the real DO', async provider => {
  const model = nativeProviders().find(p => p.id === provider)!.getModels()[0]
  const config = { ...selection({ provider, model: model.id }), thinkingLevel: getSupportedThinkingLevels(model).includes('high') ? 'high' as const : null, maxOutputTokens: 2500 }
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init), body = await request.json() as Record<string, unknown>
    requests.push({ headers: request.headers, body })
    if (JSON.stringify(body).includes('record_memory_changes')) return nativeReply(model.api, '', { name: 'record_memory_changes', arguments: { operations: [] } })
    return nativeReply(model.api, 'New protocol fixture reply', requests.length === 1)
  })
  try {
    const account = await owner(crypto.randomUUID(), () => config)
    await account.native(async n => {
      const lane = await n.getLane()
      expect(await selectedNativeModel(lane, context)).toEqual(model)
      expect((await runNative(n, 'Use read then reply')).status).toBe('done')
      await (n as unknown as { flushOutboxToRegistry(): Promise<void> }).flushOutboxToRegistry()
      await n.extractNextMemoryBatch()
    })
    const branch = await runInDurableObject(account.stub, n => n.getBranch())
    expect(branch.entries).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ role: 'toolResult' }) })]))
    expect(branch.entries.at(-1)?.message).toMatchObject({ role: 'assistant', stopReason: 'stop', content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'New protocol fixture reply' })]) })
    expect(requests.length).toBeGreaterThanOrEqual(3)
    for (const request of requests) {
      expect(request.headers.get('authorization') ?? request.headers.get('x-goog-api-key')).toContain(config.apiKey)
      if (provider === 'google-vertex') expect(request.body).toMatchObject({ generationConfig: { maxOutputTokens: 2500, thinkingConfig: { thinkingBudget: 24576 } } })
      else if (provider === 'mistral') expect(request.body.max_tokens).toBe(2500)
      else if (provider === 'radius') expect(request.body).toMatchObject({ options: { maxTokens: 2500, reasoning: 'high' } })
      else expect(request.body).toMatchObject({ inferenceConfig: { maxTokens: 2500 } })
    }
  } finally { vi.restoreAllMocks() }
})


it('preserves held native manual compaction during settings and tool refresh, then uses the new configuration', async () => {
  const a = { ...selection(selections[0], 'held-compaction-key-a'), maxOutputTokens: 2500, thinkingLevel: 'low' as const }
  const b = { ...selection(selections[4], 'held-compaction-key-b'), maxOutputTokens: 1800 }
  let current: ModelSelection = a, searchEnabled = false, release: (() => void) | undefined
  const requests: Array<{ key: string | null; body: Record<string, unknown> }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push({ key: request.headers.get('authorization'), body: await request.json() })
    if (requests.length === 1) await new Promise<void>(resolve => { release = resolve })
    return nativeReply(request.url.includes('deepseek') ? 'deepseek' : 'openrouter', 'Continuity checkpoint')
  })
  let socket: WebSocket | undefined, client: Awaited<ReturnType<typeof openChat>> | undefined
  let dispose: (() => Promise<void>) | undefined
  try {
    const account = await owner(crypto.randomUUID(), () => current, () => searchEnabled)
    dispose = () => account.native(n => (n as unknown as NativeFixture).native.dispose())
    await runInDurableObject(account.stub, instance => instance.updateCompactionSettings({ enabled: true, reserveTokens: 1000, keepRecentTokens: 100 }))
    const original = await account.native(async n => {
      const lane = await n.getLane()
      for (let index = 0; index < 4; index++) await appendNative(lane, { role: 'user', content: 'Held compaction history ' + 'a'.repeat(12000), timestamp: Date.now() }, context)
      return (n as unknown as NativeFixture).getHarness()
    })
    const response = await worker.fetch(new Request('https://chat.fixture/api/chat/socket', { headers: { ...headers, 'x-lamplit-instance': (await account.native(n => Reflect.get(n, 'name') as string)).split(':')[0], 'x-lamplit-session-hash': 'a'.repeat(64), upgrade: 'websocket' } }), account.localEnv)
    socket = response.webSocket!; socket.accept()
    let view: ChatView | undefined
    client = await openChat(socket, value => { view = value }, () => {})
    expect((await client.compact({ sessionId: account.sessionId })).accepted).toBe(true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const reads = await account.native(n => vi.spyOn(n, 'getLane'))
    current = b; searchEnabled = true
    const before = reads.mock.calls.length
    await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(before + 2), { timeout: 10000 })
    await account.native(async n => {
      expect(await (n as unknown as NativeFixture).getHarness()).toBe(original)
      expect((await (n as unknown as NativeFixture).native.pending())).toHaveLength(0)
      const lane = await n.getLane()
      expect(await selectedNativeModel(lane, context)).toEqual(selectedModel(a))
      expect((await lane.agent(context)).tools.some(tool => tool.name === 'web_search')).toBe(false)
      release!()
    })
    await vi.waitFor(() => expect(view?.compaction?.status).toBe('complete'), { timeout: 10000 })
    await account.native(async n => { expect((await runNative(n, 'After held compaction')).status).toBe('done'); expect((await (await n.getLane()).agent(context)).tools.some(tool => tool.name === 'web_search')).toBe(true) })
    expect(requests[0]).toMatchObject({ key: 'Bearer held-compaction-key-a', body: { model: a.model, max_tokens: 2500, thinking: { type: 'enabled' } } })
    expect(requests.at(-1)).toMatchObject({ key: 'Bearer held-compaction-key-b', body: { model: b.model, max_completion_tokens: 1800 } })
  } finally { release?.(); client?.close(); socket?.close(); await dispose?.(); vi.restoreAllMocks() }
})
