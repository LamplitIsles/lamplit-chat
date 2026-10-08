import { expect, it, vi } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import type { PiSession } from './pi-session'
import type { PiRegistry } from './pi-registry'
import { nativeOptions } from './fixtures/native-harness-options'
import { nativeReply } from './fixtures/native-provider'
import { runNative, type NativeFixture } from './fixtures/native-session'
import { remoteSchema } from './fixtures/remote-mcp'
import { remoteToolName } from './injected-remote-mcp'

it('retries only failed discovery on a later idle submission and offers recovered tools in the native request', async () => {
  const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const methods: string[] = [], bodies: { tools: { function: { name: string; parameters: unknown } }[] }[] = []
  let recovered = false, holdModel = false
  let modelStarted!: () => void, releaseModel!: () => void
  const started = new Promise<void>(resolve => { modelStarted = resolve })
  const held = new Promise<void>(resolve => { releaseModel = resolve })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('.visibility.fixture.invalid')) {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      const rpc = JSON.parse(init!.body as string)
      const peer = url.includes('recover.') ? 'recover' : 'good'
      methods.push(`${peer}:${rpc.method}`)
      if (peer === 'recover' && !recovered) return new Response(null, { status: 503 })
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      expect(['initialize', 'tools/list']).toContain(rpc.method)
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'echo', description: 'Fixture echo', inputSchema: remoteSchema }] }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result })
    }
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    bodies.push(JSON.parse(init!.body as string))
    if (holdModel) { modelStarted(); await held }
    return nativeReply('openrouter', 'Ordinary chat remains available')
  })
  try {
    const registry = env.PiRegistry.getByName(id) as DurableObjectStub<PiRegistry>
    const created = await registry.ensureDefaultSession()
    const stub = env.PiSession.getByName(`${id}:${created.id}`) as DurableObjectStub<PiSession>
    await runInDurableObject(stub, async instance => {
      Reflect.set(instance, 'name', `${id}:${created.id}`)
      const environment = { ...env, HOSTED_MODE: 'true', MCP_CONFIG: undefined as string | undefined }
      Reflect.set(instance, 'env', environment)
      Reflect.set(instance, 'modelEnvironment', async () => nativeOptions().env)
      vi.spyOn(instance as unknown as { scheduleMemoryExtraction(): void }, 'scheduleMemoryExtraction').mockImplementation(() => {})
      vi.spyOn(instance as unknown as { schedulePendingDrain(): Promise<void> }, 'schedulePendingDrain').mockResolvedValue()
      const native = instance as unknown as NativeFixture
      await runNative(instance, 'Existing root before MCP configuration')
      await native.native.dispose()
      environment.MCP_CONFIG = JSON.stringify({ [id]: [
        { name: 'good', url: 'https://good.visibility.fixture.invalid/mcp' },
        { name: 'recover', url: 'https://recover.visibility.fixture.invalid/mcp' },
      ] })
      const good = remoteToolName('good', 'echo'), recovery = remoteToolName('recover', 'echo')
      const names = () => bodies.at(-1)!.tools.map(tool => tool.function.name)
      holdModel = true
      const running = runNative(instance, 'First turn while peer unavailable')
      await started
      expect(names()).toContain(good); expect(names()).not.toContain(recovery)
      const attempts = methods.length
      expect(methods.filter(method => method === 'recover:initialize')).toHaveLength(1)
      recovered = true
      const busyId = crypto.randomUUID()
      const receipt = await instance.submitChat({ operationId: busyId, text: 'Steer while generation is active' })
      expect(receipt.state).toBe('submitted')
      expect(methods).toHaveLength(attempts)
      holdModel = false; releaseModel()
      await running
      await native.native.wait(busyId)
      await native.getLane() // Idle reads must not initiate discovery retries either.
      expect(methods).toHaveLength(attempts)
      recovered = false
      await runNative(instance, 'Next idle turn while peer is still unavailable')
      expect(names()).toContain(good); expect(names()).not.toContain(recovery)
      expect(methods.filter(method => method === 'recover:initialize')).toHaveLength(2)
      recovered = true
      await runNative(instance, 'Next idle turn after peer recovery')
      expect(names(), 'Recovered discovery must reach the native generation request').toContain(recovery)
      expect(names()).toContain(good); expect(names()).toContain('read')
      expect(bodies.at(-1)!.tools.find(tool => tool.function.name === recovery)?.function.parameters).toEqual(remoteSchema)
      expect(methods.filter(method => method === 'good:initialize')).toHaveLength(1)
      expect(methods.filter(method => method === 'recover:initialize')).toHaveLength(3)
      const successful = methods.length
      await runNative(instance, 'Further healthy turn')
      expect(methods).toHaveLength(successful)
      expect(names()).toContain(recovery)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('MCP discovery failed'))
      expect(methods.some(method => method.endsWith(':tools/call'))).toBe(false)
      await native.native.dispose()
    })
  } finally { releaseModel(); provider.mockRestore(); vi.restoreAllMocks() }
})
