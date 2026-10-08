import { expect, it } from 'vitest'
import { McpClient, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp'

it('runs the pinned Pi MCP public root in workerd against an isolated StreamableHTTP peer', async () => {
  const methods: string[] = []
  const client = new McpClient({ name: 'fixture', version: '1', requestTimeoutMs: 1000 })
  const transport = new StreamableHttpTransport({ url: 'https://fixture.invalid/mcp', openGetStream: false, fetch: async (_url, init) => {
    const request = JSON.parse(init!.body as string)
    methods.push(request.method)
    if (request.id === undefined) return new Response(null, { status: 202 })
    const result = request.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      : { content: [{ type: 'text', text: request.params.arguments.text }] }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  } })
  try {
    await client.connect(transport)
    expect((await client.listTools())[0].inputSchema.required).toEqual(['text'])
    expect(toLlmContent(await client.callTool('echo', { text: 'workerd proof' }))).toEqual([{ type: 'text', text: 'workerd proof' }])
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  } finally { await client.close() }
})

import { vi } from 'vitest'
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { createInjectedMcpTools, injectedServers, remoteToolName } from './injected-remote-mcp'
import { fakeMcp, remoteSchema } from './fixtures/remote-mcp'
import { nativeOptions } from './fixtures/native-harness-options'
import { nativeReply } from './fixtures/native-provider'
import { createPiHarness } from './create-pi-harness'

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const config = JSON.stringify({ [A]: [{ name: 'notes', url: 'https://a.fixture.invalid/mcp', bearerToken: 'secret-fixture-token' }], [B]: [{ name: 'other', url: 'https://b.fixture.invalid/mcp' }] })
const api = {} as ToolExecutionApi // These tools do not use invocation APIs; cancellation uses the real public Context.

it('isolates discovery/auth by trusted instance, preserves native schemas/results/errors and closes every session', async () => {
  const fake = fakeMcp()
  const a = (await createInjectedMcpTools(config, A, fake.fetch)).tools
  const b = (await createInjectedMcpTools(config, B, fake.fetch)).tools
  expect(a).toHaveLength(1); expect(b).toHaveLength(1)
  expect(a[0].parameters).toMatchObject(remoteSchema)
  expect(a[0].replay).toBe('unsafe') // Even the remote readOnly hint does not promise recovery safety.
  expect(a[0].name).toBe('mcp__notes_echo'); expect(b[0].name).toBe('mcp__other_echo')
  const result = await a[0].execute({ text: 'fixture' }, api, context)
  expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Remote answer' }, { type: 'image', mimeType: 'image/png' }, { type: 'text', text: '{"fixture":true}' }] })
  fake.result({ content: [], structuredContent: { only: 'structured' }, isError: true })
  expect(await b[0].execute({ text: 'fixture' }, api, context)).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('structured') }] })
  expect(fake.requests.filter(r => r.url.includes('a.fixture')).every(r => r.auth === 'Bearer secret-fixture-token')).toBe(true)
  expect(fake.requests.filter(r => r.url.includes('b.fixture')).every(r => r.auth === null)).toBe(true)
  expect(fake.requests.filter(r => r.method === 'DELETE')).toHaveLength(4)
  expect(fake.requests.filter(r => r.method !== 'DELETE').every(r => r.redirect === 'manual')).toBe(true)
  fake.fail()
  const failure = await a[0].execute({ text: 'fixture' }, api, context)
  expect(failure.isError).toBe(true); expect(JSON.stringify(failure)).not.toContain('secret-fixture-token')
})

it('offers discovered tools to a real Pi model turn, validates inputs, feeds results back and rediscovers on reopen', async () => {
  const fake = fakeMcp(), options = nativeOptions()
  const keepOpen = vi.spyOn(options.storage, 'close').mockResolvedValue()
  const requests: Record<string, unknown>[] = []
  let turn = 0
  const name = 'mcp__notes_echo'
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string))
    turn++
    return nativeReply('openrouter', 'After remote result', turn % 2 === 1 ? { name, arguments: { text: 'model request' } } : false)
  })
  for (let round = 0; round < 2; round++) {
    const tools = (await createInjectedMcpTools(config, A, fake.fetch)).tools
    const harness = await createPiHarness({ ...options, tools: [...options.tools, ...tools] })
    try {
      const root = await harness.root(context, { agent: { model: { provider: 'openrouter', modelId: 'openai/gpt-4o' } } })
      const submission = await root.submit({ type: 'input', requestId: 'remote-' + round, content: 'Use fixture echo' }, context)
      expect((await submission.wait(context)).status).toBe('done')
      const messages = (await root.context(context)).messages
      expect(messages.some(message => message.role === 'toolResult' && message.toolName === name && !message.isError)).toBe(true)
      expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'After remote result' }] })
      expect(JSON.stringify(requests.at(-1))).toContain('Remote answer')
      expect(JSON.stringify(requests)).not.toContain('secret-fixture-token')
      expect(JSON.stringify(requests)).not.toContain('a.fixture.invalid')
      expect(requests[0].tools).toMatchObject([{ function: { name: 'read' } }, { function: { name, parameters: remoteSchema } }])
    } finally { await harness.close(context) }
  }
  expect(fake.requests.filter(r => r.method === 'tools/call').map(r => r.params)).toEqual([{ name: 'echo', arguments: { text: 'model request' } }, { name: 'echo', arguments: { text: 'model request' } }])
  keepOpen.mockRestore(); await options.storage.close(context); provider.mockRestore()
})

it('keeps normal native chat available without config or after bounded discovery failure', async () => {
  const fake = fakeMcp(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect((await createInjectedMcpTools(undefined, A, fake.fetch)).tools).toEqual([])
  expect((await createInjectedMcpTools(config, 'cccccccc-cccc-cccc-cccc-cccccccccccc', fake.fetch)).tools).toEqual([])
  expect(fake.requests).toHaveLength(0)
  fake.fail()
  expect((await createInjectedMcpTools(config, A, fake.fetch)).tools).toEqual([])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('MCP discovery failed'))
  const options = nativeOptions()
  const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(nativeReply('openrouter', 'Normal chat'))
  const harness = await createPiHarness(options)
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'openrouter', modelId: 'openai/gpt-4o' } } })
    const submission = await root.submit({ type: 'input', requestId: 'normal', content: 'Hello' }, context)
    expect((await submission.wait(context)).status).toBe('done')
    expect((await root.context(context)).messages.at(-1)).toMatchObject({ content: [{ type: 'text', text: 'Normal chat' }] })
  } finally { await harness.close(context); provider.mockRestore(); log.mockRestore() }
})

it('aborts stalled call I/O on caller cancellation without replaying external operations', async () => {
  const fake = fakeMcp(), controller = new AbortController()
  const [tool] = (await createInjectedMcpTools(config, A, fake.fetch)).tools
  // Hold only the call so cancellation exercises callTool and its request signal.
  const heldFetch = fake.fetch
  const spy = vi.fn(heldFetch)
  // New tools retain their own test-owned fetch; initialize completes before we hold the call.
  const holding = async (...args: Parameters<typeof heldFetch>) => {
    if (args[1]?.method === 'DELETE') return spy(...args)
    const request = JSON.parse(args[1]!.body as string)
    if (request.method === 'tools/call') {
      fake.holdCall()
      queueMicrotask(() => controller.abort())
    }
    return spy(...args)
  }
  const [cancelTool] = (await createInjectedMcpTools(config, A, holding)).tools
  const result = await cancelTool.execute({ text: 'cancel' }, api, withAbortSignal(controller.signal, context))
  expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('cancelled') }] })
  expect(fake.aborted()).toBeGreaterThan(0)
  expect(fake.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
  expect(fake.requests.some(r => r.method === 'notifications/cancelled')).toBe(true)
  expect(fake.requests.filter(r => r.method === 'DELETE')).toHaveLength(3)
  expect(tool.replay).toBe('unsafe')
})

it('bounds initialization and calls with deadlines and never retries uncertain operations', async () => {
  const fake = fakeMcp(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const [tool] = (await createInjectedMcpTools(config, A, fake.fetch)).tools
  vi.useFakeTimers()
  try {
    fake.holdCall()
    const call = tool.execute({ text: 'timeout' }, api, context)
    await vi.advanceTimersByTimeAsync(30001)
    expect(await call).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('timed out') }] })
    fake.hold()
    const discovery = createInjectedMcpTools(config, A, fake.fetch)
    await vi.advanceTimersByTimeAsync(15001)
    expect((await discovery).tools).toEqual([])
    expect(fake.aborted()).toBeGreaterThanOrEqual(2)
    expect(fake.requests.filter(r => r.method === 'tools/call')).toHaveLength(1)
  } finally { vi.useRealTimers(); log.mockRestore() }
})

it('rejects malformed configuration without secrets', async () => {
  for (const value of ['bad-json', '[]', JSON.stringify({ [A]: [{ name: 'x', url: 'http://fixture.invalid', bearerToken: 'secret-fixture-token' }] }), JSON.stringify({ [A]: [{ name: 'x', url: 'https://user:password@fixture.invalid' }] }), JSON.stringify({ [A]: [{ name: 'x', url: 'https://fixture.invalid', headers: {} }] })]) {
    expect(() => injectedServers(value, A)).toThrow('Invalid MCP_CONFIG')
    try { injectedServers(value, A) } catch (error) { expect(String(error)).not.toContain('secret-fixture-token') }
  }
})

import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import { runNative, type NativeFixture } from './fixtures/native-session'

it('wires trusted hosted identities through actual PiSession DOs and reopens without sharing clients', async () => {
  const fake = fakeMcp(), bodies: Record<string, unknown>[] = []
  let modelTurn = 0, activeName = ''
  const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('.fixture.invalid')) return fake.fetch(url, init)
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    bodies.push(JSON.parse(init!.body as string)); modelTurn++
    return nativeReply('openrouter', 'DO reply', modelTurn % 2 ? { name: activeName, arguments: { text: 'from DO' } } : false)
  })
  try {
    for (const id of [A, B]) {
      const registry = env.PiRegistry.getByName(id) as DurableObjectStub<PiRegistry>
      const created = await registry.ensureDefaultSession()
      const stub = env.PiSession.getByName(`${id}:${created.id}`) as DurableObjectStub<PiSession>
      activeName = remoteToolName(id === A ? 'notes' : 'other', 'echo')
      await runInDurableObject(stub, async instance => {
        Reflect.set(instance, 'name', `${id}:${created.id}`)
        Reflect.set(instance, 'env', { ...env, HOSTED_MODE: 'true', MCP_CONFIG: config })
        Reflect.set(instance, 'modelEnvironment', async () => nativeOptions().env)
        vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
        vi.spyOn(instance as unknown as { schedulePendingDrain(): Promise<void> }, 'schedulePendingDrain').mockResolvedValue()
        const native = instance as unknown as NativeFixture
        for (let round = 0; round < 2; round++) {
          await native.native.dispose()
          await native.getHarness()
          await runNative(instance, 'Call test-owned remote echo')
          const body = JSON.stringify(bodies.at(-2))
          expect(body).toContain(activeName)
          expect(body).not.toContain(remoteToolName(id === A ? 'other' : 'notes', 'echo'))
          expect(JSON.stringify(bodies.at(-1))).toContain('Remote answer')
        }
        await native.native.dispose()
      })
    }
    expect(fake.requests.filter(r => r.method === 'tools/call')).toHaveLength(4)
    expect(fake.requests.filter(r => r.url.includes('a.fixture')).every(r => r.auth === 'Bearer secret-fixture-token')).toBe(true)
    expect(fake.requests.filter(r => r.url.includes('b.fixture')).every(r => r.auth === null)).toBe(true)
  } finally { upstream.mockRestore(); vi.restoreAllMocks() }
})

it('rejects invalid model arguments using the discovered schema before sending a remote operation', async () => {
  const fake = fakeMcp(), options = nativeOptions(), name = remoteToolName('notes', 'echo')
  const tools = (await createInjectedMcpTools(config, A, fake.fetch)).tools
  let turn = 0
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => nativeReply('openrouter', 'Schema error handled', ++turn === 1 ? { name, arguments: { unexpected: 'missing required text' } } : false))
  const harness = await createPiHarness({ ...options, tools })
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'openrouter', modelId: 'openai/gpt-4o' } } })
    const submission = await root.submit({ type: 'input', requestId: 'invalid-args', content: 'Use echo' }, context)
    expect((await submission.wait(context)).status).toBe('done')
    expect((await root.context(context)).messages.some(message => message.role === 'toolResult' && message.isError)).toBe(true)
    expect(fake.requests.filter(r => r.method === 'tools/call')).toHaveLength(0)
  } finally { await harness.close(context); provider.mockRestore() }
})

it('retains configured server and original tool names without hashing or truncation', async () => {
  const fake = fakeMcp('matrix_whoami')
  const tools = (await createInjectedMcpTools(JSON.stringify({ singleton: [{ name: 'matrix', url: 'https://fixture.invalid/mcp' }] }), null, fake.fetch)).tools
  expect(tools.map(tool => tool.name)).toEqual(['mcp__matrix_matrix_whoami'])
  await tools[0].execute({ text: 'fixture' }, api, context)
  expect(fake.requests.find(request => request.method === 'tools/call')?.params).toEqual({ name: 'matrix_whoami', arguments: { text: 'fixture' } })
  expect(remoteToolName('server'.repeat(4), 'original'.repeat(4))).toBe(`mcp__${'server'.repeat(4)}_${'original'.repeat(4)}`)
})
